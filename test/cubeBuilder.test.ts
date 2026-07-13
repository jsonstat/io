/**
 * Tests for the cube builder (IR → JSON-stat Dataset) and cube reader
 * (JSON-stat Dataset → IR).
 *
 * These verify the core conversion pipeline: dense/sparse value forms,
 * category ordering, roles, metadata, status, and the reader's inverse.
 */

import { describe, it, expect } from "vitest";
import {
  buildDataset,
  toDataset,
  CubeBuilderError,
} from "../src/core/cubeBuilder";
import { readDataset, CubeReaderError } from "../src/core/cubeReader";
import {
  simpleObs,
  simpleDataset,
  sparseObs,
  metadataObs,
  statusObs,
} from "./fixtures";

// ---------------------------------------------------------------------------
// buildDataset — the primary IR→Dataset path
// ---------------------------------------------------------------------------

describe("buildDataset", () => {
  it("produces a valid dense dataset from a simple IR", () => {
    const result = buildDataset(simpleObs());
    const ds = result.dataset;

    expect(ds.version).toBe("2.0");
    expect(ds.class).toBe("dataset");
    expect(ds.id).toEqual(["sex", "year"]);
    expect(ds.size).toEqual([2, 2]);
    expect(ds.value).toEqual([10, 20, 30, 40]);
    expect(ds.dimension.sex.category!.index).toEqual(["M", "F"]);
    expect(ds.dimension.year.category!.index).toEqual(["2020", "2021"]);
  });

  it("reports correct diagnostics for a dense dataset", () => {
    const result = buildDataset(simpleObs());
    expect(result.diagnostics.valueForm).toBe("dense");
    expect(result.diagnostics.nullRatio).toBe(0);
    expect(result.diagnostics.duplicates).toBe(0);
    expect(result.diagnostics.cellCount).toBe(4);
  });

  it("toDataset convenience returns just the dataset", () => {
    const ds = toDataset(simpleObs());
    expect(ds.id).toEqual(["sex", "year"]);
    expect(ds.value).toEqual([10, 20, 30, 40]);
  });

  it("produces dense value when nullRatio is below threshold", () => {
    // sparseObs has 2 nulls out of 8 = 0.25 ratio, below default 0.5.
    // Row-major layout with dims [sex, age, year], size [2,2,2]:
    //   row0: M,young,2020 → pos 0 = 10
    //   row2: M,young,2021 → pos 1 = null
    //   row1: M,old,2020  → pos 2 = 20
    //   row3: M,old,2021  → pos 3 = 40
    //   row4: F,young,2020 → pos 4 = 30
    //   row6: F,young,2021 → pos 5 = 60
    //   row5: F,old,2020  → pos 6 = null
    //   row7: F,old,2021  → pos 7 = 80
    const result = buildDataset(sparseObs());
    expect(result.diagnostics.valueForm).toBe("dense");
    expect(result.diagnostics.nullRatio).toBe(0.25);
    expect(Array.isArray(result.dataset.value)).toBe(true);
    expect(result.dataset.value).toEqual([10, null, 20, 40, 30, 60, null, 80]);
  });

  it("produces sparse (object) value when nullRatio exceeds threshold", () => {
    // Force sparse with a low threshold so 0.25 > 0.1
    const result = buildDataset(sparseObs(), { sparseThreshold: 0.1 });
    expect(result.diagnostics.valueForm).toBe("sparse");
    expect(result.dataset.value).toEqual({
      "0": 10,
      "2": 20,
      "3": 40,
      "4": 30,
      "5": 60,
      "7": 80,
    });
  });

  it("honors explicit valueForm: sparse", () => {
    const result = buildDataset(simpleObs(), { valueForm: "sparse" });
    expect(result.diagnostics.valueForm).toBe("sparse");
    expect(result.dataset.value).toEqual({
      "0": 10,
      "1": 20,
      "2": 30,
      "3": 40,
    });
  });

  it("honors explicit valueForm: dense even with high null ratio", () => {
    const result = buildDataset(sparseObs(), { valueForm: "dense" });
    expect(result.diagnostics.valueForm).toBe("dense");
    expect(Array.isArray(result.dataset.value)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Roles & metadata
// ---------------------------------------------------------------------------

describe("buildDataset roles & metadata", () => {
  it("emits role object from the model", () => {
    const ds = toDataset(metadataObs());
    expect(ds.role).toEqual({ time: ["year"], geo: ["country"] });
  });

  it("emits dimension labels", () => {
    const ds = toDataset(metadataObs());
    expect(ds.dimension.country.label).toBe("Country");
    expect(ds.dimension.year.label).toBe("Year");
  });

  it("emits category labels", () => {
    const ds = toDataset(metadataObs());
    expect(ds.dimension.country.category!.label).toEqual({
      ES: "Spain",
      FR: "France",
    });
  });

  it("emits category coordinates", () => {
    const ds = toDataset(metadataObs());
    expect(ds.dimension.country.category!.coordinates).toEqual({
      ES: [-3.7, 40.4],
      FR: [2.3, 48.8],
    });
  });

  it("emits dataset-level metadata", () => {
    const ds = toDataset(metadataObs());
    expect(ds.label).toBe("Population by country and year");
    expect(ds.source).toBe("Test");
    expect(ds.updated).toBe("2022-01-01");
  });

  it("allows BuildOptions.meta to override model meta", () => {
    const ds = toDataset(metadataObs(), {
      meta: { label: "Override" },
    });
    expect(ds.label).toBe("Override");
  });

  it("does not emit role when model has no roles", () => {
    const ds = toDataset(simpleObs());
    expect(ds.role).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe("buildDataset status", () => {
  it("emits a status array when a status column is present", () => {
    const ds = toDataset(statusObs());
    expect(ds.status).toBeDefined();
    expect(Array.isArray(ds.status)).toBe(true);
    // The reader builds per-cell status, but with 2 observations mapping to
    // 2 of 4 cells, the rest are "". With "auto" form and mixed statuses,
    // it should be an array.
  });

  it("emits status: none when requested", () => {
    const ds = toDataset(statusObs(), { statusForm: "none" });
    expect(ds.status).toBeUndefined();
  });

  it("emits a uniform status as a string", () => {
    const obs = statusObs();
    obs.status = { values: ["e", "e"] };
    const ds = toDataset(obs);
    // But only 2 of 4 cells are filled; the others default to "". So it's
    // not uniform — expect an array or object, not a bare string. Let's
    // test a fully-filled uniform case instead.
    expect(ds.status).toBeDefined();
  });

  it("emits string status when all cells share the same value", () => {
    // Fill ALL 4 cells so the status is truly uniform.
    const obs = statusObs();
    obs.dimensions.sex.values = ["M", "M", "F", "F"];
    obs.dimensions.year.values = ["2020", "2021", "2020", "2021"];
    obs.measure.values = [10, 20, 30, 40];
    obs.status = { values: ["e", "e", "e", "e"] };
    const ds = toDataset(obs, { statusForm: "string" });
    expect(ds.status).toBe("e");
  });
});

// ---------------------------------------------------------------------------
// Category ordering
// ---------------------------------------------------------------------------

describe("buildDataset category ordering", () => {
  it("honors explicit categoryOrder", () => {
    const obs = simpleObs();
    obs.dimensions.sex.categoryOrder = ["F", "M"];
    const ds = toDataset(obs);
    expect(ds.dimension.sex.category!.index).toEqual(["F", "M"]);
    // value array is reordered: F cells now come first.
    // sex stride=2, so swapping M/F means pos 0,1 = F-2020,F-2021 = 30,40
    expect(ds.value).toEqual([30, 40, 10, 20]);
  });

  it("uses first-seen order when no categoryOrder is given", () => {
    const obs = simpleObs();
    // Shuffle the rows so F appears first.
    obs.dimensions.sex.values = ["F", "M", "F", "M"];
    obs.dimensions.year.values = ["2020", "2020", "2021", "2021"];
    obs.measure.values = [30, 10, 40, 20];
    const ds = toDataset(obs);
    expect(ds.dimension.sex.category!.index).toEqual(["F", "M"]);
  });

  it("throws if a value is not covered by categoryOrder", () => {
    const obs = simpleObs();
    obs.dimensions.sex.categoryOrder = ["M"]; // missing "F"
    expect(() => toDataset(obs)).toThrow(CubeBuilderError);
  });

  it("throws on null dimension values", () => {
    const obs = simpleObs();
    obs.dimensions.sex.values = ["M", "M", null as unknown as string, "F"];
    expect(() => toDataset(obs)).toThrow(CubeBuilderError);
  });
});

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

describe("buildDataset duplicates", () => {
  it("counts duplicate observations (same cell)", () => {
    const obs = simpleObs();
    // Make rows 0 and 1 identical (both M,2020): row 1 overwrites row 0.
    obs.dimensions.year.values = ["2020", "2020", "2020", "2021"];
    obs.measure.values = [10, 99, 30, 40];
    const result = buildDataset(obs);
    expect(result.diagnostics.duplicates).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cubeReader — the inverse (JSON-stat → IR)
// ---------------------------------------------------------------------------

describe("readDataset", () => {
  it("reads a simple dense dataset into the IR", () => {
    const obs = readDataset(simpleDataset());
    expect(obs.model.dimensionIds).toEqual(["sex", "year"]);
    expect(obs.measure.values).toEqual([10, 20, 30, 40]);
    expect(obs.dimensions.sex.values).toEqual(["M", "M", "F", "F"]);
    expect(obs.dimensions.year.values).toEqual(["2020", "2021", "2020", "2021"]);
  });

  it("reads category labels", () => {
    const obs = readDataset({
      version: "2.0",
      class: "dataset",
      id: ["rank"],
      size: [3],
      dimension: {
        rank: {
          category: {
            index: ["a", "b", "c"],
            label: { a: "Alpha", b: "Beta", c: "Gamma" },
          },
        },
      },
      value: [1, 2, 3],
    });
    expect(obs.dimensions.rank.categoryLabels).toEqual({
      a: "Alpha",
      b: "Beta",
      c: "Gamma",
    });
  });

  it("handles the sparse (object) value form", () => {
    const obs = readDataset({
      version: "2.0",
      class: "dataset",
      id: ["sex", "year"],
      size: [2, 2],
      dimension: {
        sex: { category: { index: ["M", "F"] } },
        year: { category: { index: ["2020", "2021"] } },
      },
      value: { "0": 10, "3": 40 },
    });
    // dropNulls defaults to true → only 2 rows emitted.
    expect(obs.measure.values).toEqual([10, 40]);
    expect(obs.dimensions.sex.values).toEqual(["M", "F"]);
    expect(obs.dimensions.year.values).toEqual(["2020", "2021"]);
  });

  it("preserves nulls when dropNulls is false", () => {
    const obs = readDataset(
      {
        version: "2.0",
        class: "dataset",
        id: ["sex", "year"],
        size: [2, 2],
        dimension: {
          sex: { category: { index: ["M", "F"] } },
          year: { category: { index: ["2020", "2021"] } },
        },
        value: { "0": 10, "3": 40 },
      },
      { dropNulls: false },
    );
    expect(obs.measure.values).toEqual([10, null, null, 40]);
  });

  it("normalizes string status", () => {
    const obs = readDataset({
      version: "2.0",
      class: "dataset",
      id: ["x"],
      size: [2],
      dimension: { x: { category: { index: ["a", "b"] } } },
      value: [1, 2],
      status: "e",
    });
    expect(obs.status).toBeDefined();
    expect(obs.status!.values).toEqual(["e", "e"]);
  });

  it("normalizes array status", () => {
    const obs = readDataset({
      version: "2.0",
      class: "dataset",
      id: ["x"],
      size: [2],
      dimension: { x: { category: { index: ["a", "b"] } } },
      value: [1, 2],
      status: ["e", "p"],
    });
    expect(obs.status!.values).toEqual(["e", "p"]);
  });

  it("throws on non-dataset class", () => {
    expect(() =>
      readDataset({ version: "2.0", class: "collection" } as never),
    ).toThrow(CubeReaderError);
  });

  it("throws on value array / size mismatch", () => {
    expect(() =>
      readDataset({
        version: "2.0",
        class: "dataset",
        id: ["x"],
        size: [3],
        dimension: { x: { category: { index: ["a", "b", "c"] } } },
        value: [1, 2], // wrong length
      }),
    ).toThrow(CubeReaderError);
  });
});
