/**
 * Data Package (Frictionless) adapter tests.
 *
 * Covers:
 *  - Import: schema-driven measure detection, the default-measure "value" rule,
 *    primaryKey dimensions, inline `data`, resource selection, error cases.
 *  - Export: descriptor shape (fields, primaryKey, types), CSV body.
 *  - Round-trip via the high-level `exportDataset` / `importToCube` dispatcher.
 */

import { describe, it, expect } from "vitest";
import {
  datapackageToCube,
  cubeToDataPackage,
  parseDataPackageMetadata,
  DataPackageSourceError,
} from "../src/sources/datapackage";
import type { DataPackageMetadata } from "../src/sources/datapackage";
import { exportDataset, importToCube } from "../src/index";
import { buildDataset } from "../src/core/cubeBuilder";
import { simpleDataset } from "./fixtures";
import type { Observations } from "../src/model/ir";
import type { JsonStatValue } from "../src/model/jsonstat";

/** Materialize a dense or sparse value array into a flat (number|null)[]. */
function materialize(
  value: JsonStatValue,
  total: number,
): (number | null)[] {
  if (Array.isArray(value)) return value;
  const dense = new Array(total).fill(null);
  for (const [k, v] of Object.entries(value)) {
    dense[Number(k)] = v;
  }
  return dense;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A simple Data Package: sex × year, one CSV resource `data.csv`.
 * Field `value` is numeric and named `value`, so the default-measure rule
 * picks it even though `count` is also numeric.
 */
function simplePackage(): DataPackageMetadata {
  return {
    name: "simple",
    title: "Simple dataset",
    resources: [
      {
        name: "data",
        path: "data.csv",
        dialect: { delimiter: ",", header: true },
        schema: {
          fields: [
            { name: "sex", type: "string" },
            { name: "year", type: "year" },
            { name: "value", type: "number" },
            { name: "count", type: "integer" },
          ],
          primaryKey: ["sex", "year"],
          missingValues: [""],
        },
      },
    ],
  };
}

const SIMPLE_CSV =
  "sex,year,value,count\n" +
  "M,2020,10,1\n" +
  "M,2021,20,2\n" +
  "F,2020,30,3\n" +
  "F,2021,40,4\n";

// ---------------------------------------------------------------------------
// Import — schema-driven detection
// ---------------------------------------------------------------------------

describe("datapackageToCube — schema-driven detection", () => {
  it("uses primaryKey fields as dimensions and the numeric measure", () => {
    const obs = datapackageToCube(SIMPLE_CSV, simplePackage());
    // sex + year are primaryKey dimensions; `value` is the measure; the leftover
    // `count` field is neither measure nor status, so it is appended as a
    // trailing dimension (documented adapter behavior).
    expect(obs.model.dimensionIds).toEqual(["sex", "year", "count"]);
    expect(obs.measure.name).toBe("value");
    expect(obs.measure.values).toEqual([10, 20, 30, 40]);
    expect(obs.dimensions.sex.values).toEqual(["M", "M", "F", "F"]);
    expect(obs.dimensions.year.values).toEqual(["2020", "2021", "2020", "2021"]);
    expect(obs.dimensions.count.values).toEqual(["1", "2", "3", "4"]);
  });

  it("respects the field label as the dimension label", () => {
    const pkg = simplePackage();
    (pkg.resources[0].schema!.fields[0] as { title?: string }).title = "Sex";
    const obs = datapackageToCube(SIMPLE_CSV, pkg);
    expect(obs.dimensions.sex.label).toBe("Sex");
  });
});

// ---------------------------------------------------------------------------
// Import — default-measure rule
// ---------------------------------------------------------------------------

describe("datapackageToCube — default-measure rule", () => {
  it("treats a field named 'value' as the measure even when other numeric fields exist", () => {
    const obs = datapackageToCube(SIMPLE_CSV, simplePackage());
    expect(obs.measure.name).toBe("value");
  });

  it("falls back to the first numeric-type field when no 'value' field exists", () => {
    const pkg: DataPackageMetadata = {
      name: "no-value",
      resources: [
        {
          path: "data.csv",
          schema: {
            fields: [
              { name: "sex", type: "string" },
              { name: "amount", type: "number" },
            ],
            primaryKey: ["sex"],
          },
        },
      ],
    };
    const csv = "sex,amount\nM,10\nF,20\n";
    const obs = datapackageToCube(csv, pkg);
    expect(obs.measure.name).toBe("amount");
    expect(obs.measure.values).toEqual([10, 20]);
  });

  it("honors an explicit options.measure over the 'value' default", () => {
    const obs = datapackageToCube(SIMPLE_CSV, simplePackage(), {
      measure: "count",
    });
    expect(obs.measure.name).toBe("count");
    expect(obs.measure.values).toEqual([1, 2, 3, 4]);
  });

  it("throws when no measure can be resolved (no value, no numeric field)", () => {
    const pkg: DataPackageMetadata = {
      name: "all-string",
      resources: [
        {
          path: "data.csv",
          schema: {
            fields: [
              { name: "sex", type: "string" },
              { name: "year", type: "string" },
            ],
            primaryKey: ["sex"],
          },
        },
      ],
    };
    const csv = "sex,year\nM,2020\n";
    expect(() => datapackageToCube(csv, pkg)).toThrow(DataPackageSourceError);
  });
});

// ---------------------------------------------------------------------------
// Import — primaryKey + status + inline data
// ---------------------------------------------------------------------------

describe("datapackageToCube — primaryKey, status, inline data", () => {
  it("appends non-primaryKey, non-measure fields as trailing dimensions", () => {
    // No explicit primaryKey: all non-measure fields become dimensions in order.
    const pkg: DataPackageMetadata = {
      name: "nopk",
      resources: [
        {
          path: "data.csv",
          schema: {
            fields: [
              { name: "sex", type: "string" },
              { name: "year", type: "string" },
              { name: "value", type: "number" },
            ],
          },
        },
      ],
    };
    const obs = datapackageToCube(SIMPLE_CSV, pkg);
    expect(obs.model.dimensionIds).toEqual(["sex", "year"]);
  });

  it("detects a status field named 'status'", () => {
    const csv = "sex,value,status\nM,10,e\nF,20,p\n";
    const pkg: DataPackageMetadata = {
      name: "status-pkg",
      resources: [
        {
          path: "data.csv",
          schema: {
            fields: [
              { name: "sex", type: "string" },
              { name: "value", type: "number" },
              { name: "status", type: "string" },
            ],
            primaryKey: ["sex"],
          },
        },
      ],
    };
    const obs = datapackageToCube(csv, pkg);
    expect(obs.status).toBeDefined();
    expect(obs.status!.values).toEqual(["e", "p"]);
  });

  it("reads inline `data` instead of CSV when present", () => {
    const pkg: DataPackageMetadata = {
      name: "inline",
      resources: [
        {
          data: [
            { sex: "M", value: 10 },
            { sex: "F", value: 20 },
          ],
          schema: {
            fields: [
              { name: "sex", type: "string" },
              { name: "value", type: "number" },
            ],
            primaryKey: ["sex"],
          },
        },
      ],
    };
    const obs = datapackageToCube("", pkg);
    expect(obs.dimensions.sex.values).toEqual(["M", "F"]);
    expect(obs.measure.values).toEqual([10, 20]);
  });

  it("selects a resource by resourcePath in a multi-resource package", () => {
    const pkg: DataPackageMetadata = {
      name: "multi",
      resources: [
        {
          path: "first.csv",
          schema: {
            fields: [
              { name: "a", type: "string" },
              { name: "value", type: "number" },
            ],
            primaryKey: ["a"],
          },
        },
        {
          path: "second.csv",
          schema: {
            fields: [
              { name: "b", type: "string" },
              { name: "value", type: "number" },
            ],
            primaryKey: ["b"],
          },
        },
      ],
    };
    const csv = "b,value\nx,9\n";
    const obs = datapackageToCube(csv, pkg, { resourcePath: "second.csv" });
    expect(obs.model.dimensionIds).toEqual(["b"]);
    expect(obs.measure.values).toEqual([9]);
  });
});

// ---------------------------------------------------------------------------
// Import — parser validation
// ---------------------------------------------------------------------------

describe("parseDataPackageMetadata", () => {
  it("returns the descriptor for a valid package", () => {
    const m = parseDataPackageMetadata(simplePackage());
    expect(m.resources.length).toBe(1);
  });

  it("throws when resources[] is missing", () => {
    expect(() => parseDataPackageMetadata({ name: "x" })).toThrow(
      DataPackageSourceError,
    );
  });
});

// ---------------------------------------------------------------------------
// Export — descriptor shape
// ---------------------------------------------------------------------------

describe("cubeToDataPackage", () => {
  // Build an IR from the canonical simpleDataset (sex × year, value 10/20/30/40).
  function simpleObsIr(): Observations {
    return {
      dimensions: {
        sex: { id: "sex", values: ["M", "M", "F", "F"] },
        year: { id: "year", values: ["2020", "2021", "2020", "2021"] },
      },
      measure: { values: [10, 20, 30, 40] },
      model: { dimensionIds: ["sex", "year"], valueForm: "dense" },
    };
  }

  it("emits a descriptor with a single resource, fields, and primaryKey", () => {
    const { csv, metadata } = cubeToDataPackage(simpleObsIr());
    expect(metadata.name).toBeTruthy();
    expect(metadata.resources.length).toBe(1);
    const resource = metadata.resources[0];
    expect(resource.schema!.primaryKey).toEqual(["sex", "year"]);
    const names = resource.schema!.fields.map((f) => f.name);
    expect(names).toEqual(["sex", "year", "value"]);
  });

  it("types the measure field as number and dimensions as string", () => {
    const { metadata } = cubeToDataPackage(simpleObsIr());
    const fields = metadata.resources[0].schema!.fields;
    const measureField = fields.find((f) => f.name === "value");
    expect(measureField?.type).toBe("number");
    const dimField = fields.find((f) => f.name === "sex");
    expect(dimField?.type).toBe("string");
  });

  it("produces a CSV body with a header row and one row per observation", () => {
    const { csv } = cubeToDataPackage(simpleObsIr());
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("sex,year,value");
    expect(lines.length).toBe(5); // header + 4 rows
    expect(lines[1]).toBe("M,2020,10");
  });

  it("records roles as rdfType hints when present", () => {
    const obs = simpleObsIr();
    obs.model.roles = { time: ["year"] };
    const { metadata } = cubeToDataPackage(obs);
    const yearField = metadata.resources[0].schema!.fields.find(
      (f) => f.name === "year",
    );
    expect(yearField?.rdfType).toContain("DateTime");
  });

  it("includes a status field when the IR has a status column", () => {
    const obs = simpleObsIr();
    obs.status = { values: ["e", "p", "e", "p"] };
    const { metadata } = cubeToDataPackage(obs);
    const names = metadata.resources[0].schema!.fields.map((f) => f.name);
    expect(names).toContain("status");
  });
});

// ---------------------------------------------------------------------------
// Round-trip via the high-level dispatcher
// ---------------------------------------------------------------------------

describe("exportDataset/importToCube round-trip — Data Package", () => {
  it("reproduces values via exportDataset({to:'datapackage'}) → importToCube", async () => {
    const out = (await exportDataset(simpleDataset(), {
      to: "datapackage",
    })) as { csv: string; metadata: DataPackageMetadata };

    // Re-import by passing the descriptor inline and the CSV as the source.
    const bytes = new TextEncoder().encode(out.csv);
    const obs = await importToCube(bytes, {
      from: "datapackage",
      datapackageMetadata: out.metadata,
    });
    const result = buildDataset(obs).dataset;

    expect(result.id).toEqual(simpleDataset().id);
    expect(result.size).toEqual(simpleDataset().size);
    // Materialize both value arrays into flat (number|null)[] for comparison
    // (export may pick dense or sparse independently of the original).
    const total = simpleDataset().size.reduce((p, s) => p * s, 1);
    const orig = materialize(simpleDataset().value, total);
    const got = materialize(result.value, total);
    expect(got.length).toBe(total);
    for (let i = 0; i < total; i++) {
      if (orig[i] === null) {
        expect(got[i]).toBeNull();
      } else {
        expect(got[i]).toBeCloseTo(orig[i] as number, 6);
      }
    }
  });
});
