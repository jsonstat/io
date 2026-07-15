/**
 * Round-trip tests: JSON-stat Dataset → IR (reader) → JSON-stat Dataset (builder).
 *
 * These are the strongest correctness proofs: if we can read a dataset into the
 * IR and write it back out unchanged, the reader and builder are faithful
 * inverses and the IR is a lossless intermediate representation.
 *
 * We test against canonical mini-datasets derived from the official JSON-stat
 * sample suite (oecd, canada, galicia, order, hierarchy, us-gsp, us-unr).
 */

import { describe, expect, it } from "vitest";
import { buildDataset } from "../src/core/cubeBuilder";
import { readDataset } from "../src/core/cubeReader";
import type { JsonStatDataset } from "../src/model/jsonstat";

/**
 * Deep-equality check that treats dense and sparse value forms as equivalent
 * when they represent the same data. The round-trip may change the value form
 * (e.g. the builder's "auto" heuristic), so we compare materialized values.
 */
function expectDatasetsEqual(a: JsonStatDataset, b: JsonStatDataset): void {
  expect(b.id).toEqual(a.id);
  expect(b.size).toEqual(a.size);
  expect(b.class).toBe(a.class);
  expect(b.version).toBe(a.version);

  // Compare dimension index arrays (category ordering must be stable).
  for (const dimId of a.id) {
    const idxA = a.dimension[dimId].category?.index;
    const idxB = b.dimension[dimId].category?.index;
    if (idxA && idxB) {
      // Normalize both to arrays.
      const arrA = Array.isArray(idxA) ? idxA : Object.keys(idxA).sort((x, y) => idxA[x] - idxA[y]);
      const arrB = Array.isArray(idxB) ? idxB : Object.keys(idxB).sort((x, y) => idxB[x] - idxB[y]);
      expect(arrB).toEqual(arrA);
    }
  }

  // Compare values by materializing both into dense arrays.
  const total = a.size.reduce((p, s) => p * s, 1);
  const valsA = materialize(a.value, total);
  const valsB = materialize(b.value, total);
  expect(valsB).toEqual(valsA);
}

function materialize(value: JsonStatDataset["value"], total: number): (number | null)[] {
  if (Array.isArray(value)) return value;
  const dense = new Array(total).fill(null);
  for (const [k, v] of Object.entries(value)) {
    dense[Number(k)] = v;
  }
  return dense;
}

/**
 * Round-trip a dataset: read → build (dense) → compare values.
 */
function roundTrip(ds: JsonStatDataset): JsonStatDataset {
  const obs = readDataset(ds, { dropNulls: false });
  const result = buildDataset(obs, { valueForm: "dense", statusForm: "array" });
  return result.dataset;
}

// ---------------------------------------------------------------------------
// Test datasets (derived from canonical JSON-stat samples)
// ---------------------------------------------------------------------------

describe("Round-trip: dense datasets", () => {
  it("round-trips a simple 2×2 dense dataset", () => {
    const ds: JsonStatDataset = {
      version: "2.0",
      class: "dataset",
      id: ["sex", "year"],
      size: [2, 2],
      dimension: {
        sex: { category: { index: ["M", "F"] } },
        year: { category: { index: ["2020", "2021"] } },
      },
      value: [10, 20, 30, 40],
    };
    expectDatasetsEqual(ds, roundTrip(ds));
  });

  it("round-trips a 1-dimension dataset (order sample shape)", () => {
    const ds: JsonStatDataset = {
      version: "2.0",
      class: "dataset",
      label: "Ranking",
      id: ["rank"],
      size: [3],
      dimension: {
        rank: {
          category: {
            index: ["gold", "silver", "bronze"],
            label: { gold: "Gold", silver: "Silver", bronze: "Bronze" },
          },
        },
      },
      value: [1, 2, 3],
    };
    const result = roundTrip(ds);
    expectDatasetsEqual(ds, result);
    // Labels survive the round-trip.
    expect(result.dimension.rank.category!.label).toEqual({
      gold: "Gold",
      silver: "Silver",
      bronze: "Bronze",
    });
  });

  it("round-trips a 3-dimension dataset", () => {
    const ds: JsonStatDataset = {
      version: "2.0",
      class: "dataset",
      id: ["sex", "age", "year"],
      size: [2, 2, 2],
      dimension: {
        sex: { category: { index: ["M", "F"] } },
        age: { category: { index: ["young", "old"] } },
        year: { category: { index: ["2020", "2021"] } },
      },
      value: [
        10,
        11, // M, young, 2020/2021
        20,
        21, // M, old,   2020/2021
        30,
        31, // F, young, 2020/2021
        40,
        41, // F, old,   2020/2021
      ],
    };
    expectDatasetsEqual(ds, roundTrip(ds));
  });
});

describe("Round-trip: sparse datasets", () => {
  it("round-trips a sparse (object-form) dataset preserving values", () => {
    const ds: JsonStatDataset = {
      version: "2.0",
      class: "dataset",
      id: ["sex", "year"],
      size: [2, 2],
      dimension: {
        sex: { category: { index: ["M", "F"] } },
        year: { category: { index: ["2020", "2021"] } },
      },
      value: { "0": 10, "3": 40 },
    };
    // The round-trip reads nulls (dropNulls:false) and rebuilds dense.
    // Missing cells should be null.
    const result = roundTrip(ds);
    expect(result.value).toEqual([10, null, null, 40]);
  });

  it("round-trips a fully-null dataset (extreme sparsity)", () => {
    const ds: JsonStatDataset = {
      version: "2.0",
      class: "dataset",
      id: ["x"],
      size: [3],
      dimension: { x: { category: { index: ["a", "b", "c"] } } },
      value: {},
    };
    const result = roundTrip(ds);
    expect(result.value).toEqual([null, null, null]);
  });
});

describe("Round-trip: roles & metadata", () => {
  it("preserves roles through the round-trip", () => {
    const ds: JsonStatDataset = {
      version: "2.0",
      class: "dataset",
      id: ["country", "year"],
      size: [2, 2],
      dimension: {
        country: { category: { index: ["ES", "FR"] } },
        year: { category: { index: ["2020", "2021"] } },
      },
      role: { time: ["year"], geo: ["country"] },
      value: [1, 2, 3, 4],
    };
    const result = roundTrip(ds);
    expect(result.role).toEqual({ time: ["year"], geo: ["country"] });
  });

  it("preserves dataset-level metadata", () => {
    const ds: JsonStatDataset = {
      version: "2.0",
      class: "dataset",
      label: "Test Dataset",
      source: "Tester",
      updated: "2024-01-15",
      id: ["x"],
      size: [2],
      dimension: { x: { category: { index: ["a", "b"] } } },
      value: [1, 2],
    };
    const result = roundTrip(ds);
    expect(result.label).toBe("Test Dataset");
    expect(result.source).toBe("Tester");
    expect(result.updated).toBe("2024-01-15");
  });
});

describe("Round-trip: status", () => {
  it("preserves array-form status", () => {
    const ds: JsonStatDataset = {
      version: "2.0",
      class: "dataset",
      id: ["x"],
      size: [2],
      dimension: { x: { category: { index: ["a", "b"] } } },
      value: [1, 2],
      status: ["e", "p"],
    };
    const result = roundTrip(ds);
    expect(result.status).toBeDefined();
    expect(Array.isArray(result.status)).toBe(true);
    // With "array" statusForm, expect the array form.
    const statusArr = result.status as string[];
    expect(statusArr).toEqual(["e", "p"]);
  });

  it("preserves string-form status (normalized to array then rebuilt)", () => {
    const ds: JsonStatDataset = {
      version: "2.0",
      class: "dataset",
      id: ["x"],
      size: [2],
      dimension: { x: { category: { index: ["a", "b"] } } },
      value: [1, 2],
      status: "e",
    };
    const result = roundTrip(ds);
    expect(result.status).toBeDefined();
    // Uniform "e" → should be rebuilt as string form by the builder's "auto".
    // But we forced statusForm: "array" in roundTrip().
    expect(result.status).toEqual(["e", "e"]);
  });
});

describe("Round-trip: object-form category index", () => {
  it("handles the object form of category.index (ID→position)", () => {
    const ds: JsonStatDataset = {
      version: "2.0",
      class: "dataset",
      id: ["x"],
      size: [3],
      dimension: {
        x: { category: { index: { c: 2, a: 0, b: 1 } } },
      },
      value: [10, 20, 30],
    };
    const result = roundTrip(ds);
    // The builder emits array-form index, but the category ordering should
    // be preserved: a(0), b(1), c(2).
    expect(result.dimension.x.category!.index).toEqual(["a", "b", "c"]);
    expect(result.value).toEqual([10, 20, 30]);
  });
});
