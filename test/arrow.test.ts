/**
 * Tests for the Arrow hub: arrowToCube (Table→IR) and cubeToArrow (IR→Table).
 *
 * These are critical because they exercise the apache-arrow v17 API and the
 * jsonstat.* metadata contract that all source adapters (Parquet, DuckDB,
 * Polars) depend on. A round-trip (IR→Arrow→IR) proves the converters are
 * faithful inverses.
 */

import {
  Dictionary,
  Field,
  Float64,
  Int32,
  Schema,
  Table,
  Utf8,
  makeVector,
  vectorFromArray,
} from "apache-arrow";
import { describe, expect, it } from "vitest";
import { cubeToArrow } from "../src/arrow/arrowFromCube";
import { ArrowConversionError, arrowToCube, arrowToDataset } from "../src/arrow/arrowToCube";
import {
  buildFieldMeta,
  buildSchemaMeta,
  getFieldMeta,
  getFieldRole,
} from "../src/arrow/schemaMeta";
import { metadataObs, simpleObs, statusObs } from "./fixtures";

// ---------------------------------------------------------------------------
// Helpers: build Arrow tables from raw arrays
// ---------------------------------------------------------------------------

/**
 * Build a simple Arrow table with dictionary-encoded dimension columns and a
 * Float64 measure column — the shape that Parquet/DuckDB/Polars emit.
 */
function buildSimpleTable(): Table {
  // Two dimension columns (dictionary-encoded) + one measure (Float64).
  const sexVec = vectorFromArray(["M", "M", "F", "F"], new Dictionary(new Utf8(), new Int32()));
  const yearVec = vectorFromArray(
    ["2020", "2021", "2020", "2021"],
    new Dictionary(new Utf8(), new Int32()),
  );
  const valueVec = makeVector(new Float64Array([10, 20, 30, 40]));

  const fields = [
    new Field("sex", new Dictionary(new Utf8(), new Int32()), true),
    new Field("year", new Dictionary(new Utf8(), new Int32()), true),
    new Field("value", new Float64(), true),
  ];

  const schema = new Schema(fields, buildSchemaMeta({ valueForm: "dense" }));
  return new Table(schema, { sex: sexVec, year: yearVec, value: valueVec });
}

/** Build a table with metadata-rich fields (roles, labels, measure marker). */
function buildMetadataTable(): Table {
  const countryField = new Field(
    "country",
    new Dictionary(new Utf8(), new Int32()),
    true,
    buildFieldMeta({
      role: "geo",
      label: "Country",
      categoryLabels: { ES: "Spain", FR: "France" },
      categoryCoords: { ES: [-3.7, 40.4], FR: [2.3, 48.8] },
    }),
  );
  const yearField = new Field(
    "year",
    new Dictionary(new Utf8(), new Int32()),
    true,
    buildFieldMeta({ role: "time" }),
  );
  const valueField = new Field("value", new Float64(), true, buildFieldMeta({ measure: true }));

  const countryVec = vectorFromArray(
    ["ES", "ES", "FR", "FR"],
    new Dictionary(new Utf8(), new Int32()),
  );
  const yearVec = vectorFromArray(
    ["2020", "2021", "2020", "2021"],
    new Dictionary(new Utf8(), new Int32()),
  );
  const valueVec = makeVector(new Float64Array([100, 110, 90, 95]));

  const schema = new Schema(
    [countryField, yearField, valueField],
    buildSchemaMeta({ label: "Test", source: "Fixtures" }),
  );

  return new Table(schema, {
    country: countryVec,
    year: yearVec,
    value: valueVec,
  });
}

// ---------------------------------------------------------------------------
// arrowToCube — Table → IR
// ---------------------------------------------------------------------------

describe("arrowToCube", () => {
  it("converts a simple dictionary+Float64 table to IR", () => {
    const table = buildSimpleTable();
    const obs = arrowToCube(table);

    expect(obs.model.dimensionIds).toEqual(["sex", "year"]);
    expect(obs.measure.values).toEqual([10, 20, 30, 40]);
    expect(obs.dimensions.sex.values).toEqual(["M", "M", "F", "F"]);
    expect(obs.dimensions.year.values).toEqual(["2020", "2021", "2020", "2021"]);
  });

  it("detects the measure column from the first numeric column", () => {
    const table = buildSimpleTable();
    const obs = arrowToCube(table);
    expect(obs.measure.name).toBe("value");
  });

  it("detects dimensions from dictionary-encoded columns", () => {
    const table = buildSimpleTable();
    const obs = arrowToCube(table);
    expect(Object.keys(obs.dimensions).sort()).toEqual(["sex", "year"]);
  });

  it("reads field metadata: roles, labels, category labels", () => {
    const table = buildMetadataTable();
    const obs = arrowToCube(table);

    expect(obs.dimensions.country.label).toBe("Country");
    expect(obs.dimensions.country.categoryLabels).toEqual({
      ES: "Spain",
      FR: "France",
    });
    expect(obs.dimensions.country.categoryCoordinates).toEqual({
      ES: [-3.7, 40.4],
      FR: [2.3, 48.8],
    });
    expect(obs.model.roles?.geo).toEqual(["country"]);
    expect(obs.model.roles?.time).toEqual(["year"]);
  });

  it("reads schema-level metadata (label, source)", () => {
    const table = buildMetadataTable();
    const obs = arrowToCube(table);
    expect(obs.model.meta?.label).toBe("Test");
    expect(obs.model.meta?.source).toBe("Fixtures");
  });

  it("honors explicit options.measure", () => {
    const table = buildSimpleTable();
    const obs = arrowToCube(table, { measure: "value" });
    expect(obs.measure.name).toBe("value");
  });

  it("honors explicit options.dimensions", () => {
    const table = buildSimpleTable();
    const obs = arrowToCube(table, { dimensions: ["sex"] });
    expect(Object.keys(obs.dimensions)).toEqual(["sex"]);
  });

  it("throws on an empty table", () => {
    const schema = new Schema([
      new Field("x", new Dictionary(new Utf8(), new Int32()), true),
      new Field("v", new Float64(), true),
    ]);
    // `new Table(schema)` yields a 0-row table with the given schema.
    const emptyTable = new Table(schema);
    expect(() => arrowToCube(emptyTable)).toThrow(ArrowConversionError);
  });

  it("throws when no numeric column exists (no measure candidate)", () => {
    const sexVec = vectorFromArray(["M", "F"], new Dictionary(new Utf8(), new Int32()));
    const schema = new Schema([new Field("sex", new Dictionary(new Utf8(), new Int32()), true)]);
    const table = new Table(schema, { sex: sexVec });
    expect(() => arrowToCube(table)).toThrow(/No measure column/);
  });

  it("handles a Utf8 (non-dictionary) dimension column", () => {
    const nameVec = vectorFromArray(["a", "b"], new Utf8());
    const valVec = makeVector(new Float64Array([1, 2]));
    const schema = new Schema([
      new Field("name", new Utf8(), true),
      new Field("v", new Float64(), true),
    ]);
    const table = new Table(schema, { name: nameVec, v: valVec });
    const obs = arrowToCube(table);
    expect(obs.dimensions.name.values).toEqual(["a", "b"]);
    expect(obs.measure.values).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// arrowToDataset — convenience wrapper
// ---------------------------------------------------------------------------

describe("arrowToDataset", () => {
  it("produces a JSON-stat dataset from an Arrow table", async () => {
    const table = buildSimpleTable();
    const ds = await arrowToDataset(table);
    expect(ds.class).toBe("dataset");
    expect(ds.id).toEqual(["sex", "year"]);
    expect(ds.size).toEqual([2, 2]);
    expect(ds.value).toEqual([10, 20, 30, 40]);
  });
});

// ---------------------------------------------------------------------------
// cubeToArrow — IR → Table (Phase-2 seam)
// ---------------------------------------------------------------------------

describe("cubeToArrow", () => {
  it("produces an Arrow table with the correct number of rows", () => {
    const table = cubeToArrow(simpleObs());
    expect(table.numRows).toBe(4);
    expect(table.numCols).toBe(3); // sex, year, value
  });

  it("encodes dimension columns as dictionary vectors", () => {
    const table = cubeToArrow(simpleObs());
    const sexCol = table.getChild("sex");
    expect(sexCol).toBeDefined();
    // Dictionary type check: the vector should have a dictionary data type.
    expect(sexCol!.type instanceof Dictionary).toBe(true);
  });

  it("encodes the measure column as Float64", () => {
    const table = cubeToArrow(simpleObs());
    const valCol = table.getChild("value");
    expect(valCol).toBeDefined();
    expect(valCol!.type instanceof Float64).toBe(true);
  });

  it("preserves nulls in the measure column", () => {
    const obs = simpleObs();
    obs.measure.values = [10, null, 30, 40];
    const table = cubeToArrow(obs);
    const valCol = table.getChild("value")!;
    expect(valCol.get(0)).toBe(10);
    expect(valCol.get(1)).toBeNull();
    expect(valCol.get(2)).toBe(30);
  });

  it("attaches role metadata to dimension fields", () => {
    const table = cubeToArrow(metadataObs());
    const countryField = table.schema.fields.find((f) => f.name === "country")!;
    expect(getFieldRole(countryField)).toBe("geo");
    const yearField = table.schema.fields.find((f) => f.name === "year")!;
    expect(getFieldRole(yearField)).toBe("time");
  });

  it("attaches measure marker to the measure field", () => {
    const table = cubeToArrow(simpleObs());
    const valField = table.schema.fields.find((f) => f.name === "value")!;
    expect(getFieldMeta(valField, "measure")).toBe("true");
  });

  it("attaches schema-level metadata", () => {
    const table = cubeToArrow(metadataObs());
    expect(table.schema.metadata.get("jsonstat.label")).toBe("Population by country and year");
    expect(table.schema.metadata.get("jsonstat.source")).toBe("Test");
  });

  it("includes a status column when status is present", () => {
    const table = cubeToArrow(statusObs());
    expect(table.getChild("status")).toBeDefined();
    const statusField = table.schema.fields.find((f) => f.name === "status");
    expect(statusField).toBeDefined();
    expect(getFieldMeta(statusField!, "status")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: IR → Arrow → IR
// ---------------------------------------------------------------------------

describe("Arrow round-trip (IR → Arrow → IR)", () => {
  it("preserves values and dimension membership", () => {
    const original = simpleObs();
    const table = cubeToArrow(original);
    const roundTripped = arrowToCube(table);

    expect(roundTripped.measure.values).toEqual(original.measure.values);
    expect(roundTripped.model.dimensionIds).toEqual(original.model.dimensionIds);
    // Dimension values should match.
    for (const id of original.model.dimensionIds) {
      expect(roundTripped.dimensions[id].values).toEqual(original.dimensions[id].values);
    }
  });

  it("preserves roles through the round-trip", () => {
    const original = metadataObs();
    const table = cubeToArrow(original);
    const roundTripped = arrowToCube(table);

    expect(roundTripped.model.roles?.geo).toEqual(["country"]);
    expect(roundTripped.model.roles?.time).toEqual(["year"]);
  });

  it("preserves category labels through the round-trip", () => {
    const original = metadataObs();
    const table = cubeToArrow(original);
    const roundTripped = arrowToCube(table);

    expect(roundTripped.dimensions.country.categoryLabels).toEqual({
      ES: "Spain",
      FR: "France",
    });
  });
});
