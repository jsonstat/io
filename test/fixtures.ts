/**
 * Shared test fixtures — IR observations and canonical JSON-stat datasets
 * derived from the official JSON-stat sample suite (see wiki/sample-files.md).
 *
 * These are compact, hand-verified mini-cubes that exercise the key structural
 * features without the verbosity of the full upstream samples.
 */

import type { Observations } from "../src/model/ir";
import type { JsonStatDataset } from "../src/model/jsonstat";

// ---------------------------------------------------------------------------
// A simple 2×2 IR: sex × year, 4 cells, all filled (dense)
// ---------------------------------------------------------------------------

/** IR with 2 dimensions (sex: M/F, year: 2020/2021), no nulls. */
export function simpleObs(): Observations {
  return {
    dimensions: {
      sex: {
        id: "sex",
        values: ["M", "M", "F", "F"],
      },
      year: {
        id: "year",
        values: ["2020", "2021", "2020", "2021"],
      },
    },
    measure: {
      values: [10, 20, 30, 40],
    },
    model: {
      dimensionIds: ["sex", "year"],
      valueForm: "dense",
    },
  };
}

/**
 * The canonical dense JSON-stat dataset corresponding to `simpleObs()`.
 *
 * Row-major order with id=["sex","year"] and size=[2,2]:
 *   pos 0 = sex[0]=M,  year[0]=2020 → 10
 *   pos 1 = sex[0]=M,  year[1]=2021 → 20
 *   pos 2 = sex[1]=F,  year[0]=2020 → 30
 *   pos 3 = sex[1]=F,  year[1]=2021 → 40
 */
export function simpleDataset(): JsonStatDataset {
  return {
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
}

// ---------------------------------------------------------------------------
// A 3-dimension IR: sex × age × year, 8 cells, sparse (2 nulls)
// ---------------------------------------------------------------------------

/** IR with 3 dimensions, 2 nulls out of 8 cells (nullRatio = 0.25). */
export function sparseObs(): Observations {
  return {
    dimensions: {
      sex: {
        id: "sex",
        values: ["M", "M", "M", "M", "F", "F", "F", "F"],
      },
      age: {
        id: "age",
        values: ["young", "old", "young", "old", "young", "old", "young", "old"],
      },
      year: {
        id: "year",
        values: ["2020", "2020", "2021", "2021", "2020", "2020", "2021", "2021"],
      },
    },
    measure: {
      values: [10, 20, null, 40, 30, null, 60, 80],
    },
    model: {
      dimensionIds: ["sex", "age", "year"],
      valueForm: "auto",
    },
  };
}

// ---------------------------------------------------------------------------
// An IR with roles + labels + units (metadata-rich)
// ---------------------------------------------------------------------------

/** IR with time/geo/metric roles, category labels, and units. */
export function metadataObs(): Observations {
  return {
    dimensions: {
      country: {
        id: "country",
        label: "Country",
        values: ["ES", "ES", "FR", "FR"],
        categoryLabels: { ES: "Spain", FR: "France" },
        categoryCoordinates: {
          ES: [-3.7, 40.4],
          FR: [2.3, 48.8],
        },
      },
      year: {
        id: "year",
        label: "Year",
        values: ["2020", "2021", "2020", "2021"],
      },
    },
    measure: {
      name: "value",
      values: [100, 110, 90, 95],
    },
    model: {
      dimensionIds: ["country", "year"],
      roles: { time: ["year"], geo: ["country"] },
      meta: {
        label: "Population by country and year",
        source: "Test",
        updated: "2022-01-01",
      },
      valueForm: "dense",
    },
  };
}

// ---------------------------------------------------------------------------
// An IR with a status column
// ---------------------------------------------------------------------------

/** IR with a per-row status column. */
export function statusObs(): Observations {
  return {
    dimensions: {
      sex: { id: "sex", values: ["M", "F"] },
      year: { id: "year", values: ["2020", "2021"] },
    },
    measure: { values: [10, 20] },
    status: { values: ["e", "p"] }, // e=estimate, p=provisional
    model: {
      dimensionIds: ["sex", "year"],
      valueForm: "dense",
    },
  };
}

// ---------------------------------------------------------------------------
// Canonical JSON-stat datasets (the round-trip targets)
// ---------------------------------------------------------------------------

/** The classic "order" sample: 1 dimension, explicit category order. */
export function orderDataset(): JsonStatDataset {
  return {
    version: "2.0",
    class: "dataset",
    label: "Order demo",
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
}

/** A sparse dataset: object-form value with some missing cells. */
export function sparseDataset(): JsonStatDataset {
  return {
    version: "2.0",
    class: "dataset",
    id: ["sex", "year"],
    size: [2, 2],
    dimension: {
      sex: { category: { index: ["M", "F"] } },
      year: { category: { index: ["2020", "2021"] } },
    },
    // Only positions 0 and 3 are present (object form).
    value: { "0": 10, "3": 40 },
  };
}
