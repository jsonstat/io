/**
 * Export round-trip tests: JSON-stat Dataset → export (columnar) → import → Dataset.
 *
 * These prove the Phase 2 bidirectional contract: data exported to any columnar
 * format via `exportDataset` can be re-imported and reproduces the original
 * values. We compare materialized value arrays (dense form) to avoid coupling
 * to the dense/sparse heuristic that may differ on the return path.
 *
 * Formats tested:
 *  - Arrow  (via `exportDataset({ to: "arrow" })` → `arrowToDataset`)
 *  - CSV    (via `exportDataset({ to: "csv" })` → `csvToDataset`)
 *  - CSVW   (via `exportDataset({ to: "csvw" })` → `csvwToDataset`)
 *  - Parquet (via `cubeToParquet` → `parquetToDataset`) [requires parquet-wasm]
 */

import { describe, it, expect } from "vitest";
import { exportDataset } from "../src/index";
import { arrowToDataset } from "../src/arrow/arrowToCube";
import { csvToDataset } from "../src/sources/csv";
import { csvwToDataset } from "../src/sources/csvw";
import { parquetToDataset } from "../src/sources/parquet";
import { simpleDataset, orderDataset } from "./fixtures";
import type { JsonStatDataset } from "../src/model/jsonstat";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Materialize a dense or sparse value array into a flat (number|null)[]. */
function materializeValues(
  value: JsonStatDataset["value"],
  total: number,
): (number | null)[] {
  if (Array.isArray(value)) return value;
  const dense = new Array(total).fill(null);
  for (const [k, v] of Object.entries(value)) {
    dense[Number(k)] = v;
  }
  return dense;
}

/**
 * Compare two datasets by materialized values + dimension id/size. We don't
 * require identical `value` shapes (dense vs sparse) since the import heuristic
 * may choose differently from the original — only the cell contents must match.
 */
function expectValuesEqual(
  original: JsonStatDataset,
  reimported: JsonStatDataset,
): void {
  expect(reimported.id).toEqual(original.id);
  expect(reimported.size).toEqual(original.size);

  const total = original.size.reduce((p, s) => p * s, 1);
  const origVals = materializeValues(original.value, total);
  const reVals = materializeValues(reimported.value, total);

  // Compare element-by-element, treating null and NaN equivalently.
  expect(reVals.length).toBe(origVals.length);
  for (let i = 0; i < origVals.length; i++) {
    const a = origVals[i];
    const b = reVals[i];
    if (a === null || b === null) {
      expect(b).toBe(a);
    } else {
      expect(b).toBeCloseTo(a, 6);
    }
  }
}

// ---------------------------------------------------------------------------
// Arrow export round-trip
// ---------------------------------------------------------------------------

describe("Export round-trip: Arrow", () => {
  it("reproduces values via exportDataset({to:'arrow'}) → arrowToDataset", async () => {
    const table = (await exportDataset(simpleDataset(), { to: "arrow" })) as any;
    const result = await arrowToDataset(table);
    expectValuesEqual(simpleDataset(), result);
  });

  it("round-trips a 1-dimension dataset through Arrow", async () => {
    const table = (await exportDataset(orderDataset(), { to: "arrow" })) as any;
    const result = await arrowToDataset(table);
    expectValuesEqual(orderDataset(), result);
  });
});

// ---------------------------------------------------------------------------
// CSV export round-trip
// ---------------------------------------------------------------------------

describe("Export round-trip: CSV", () => {
  it("reproduces values via exportDataset({to:'csv'}) → csvToDataset", async () => {
    const text = (await exportDataset(simpleDataset(), { to: "csv" })) as string;
    // Re-import with explicit measure name "value" (the default export header).
    const result = await csvToDataset(text, { measure: "value" });
    expectValuesEqual(simpleDataset(), result);
  });

  it("round-trips a 1-dimension dataset through CSV", async () => {
    const text = (await exportDataset(orderDataset(), { to: "csv" })) as string;
    const result = await csvToDataset(text, { measure: "value" });
    expectValuesEqual(orderDataset(), result);
  });
});

// ---------------------------------------------------------------------------
// CSVW export round-trip
// ---------------------------------------------------------------------------

describe("Export round-trip: CSVW", () => {
  it("reproduces values via exportDataset({to:'csvw'}) → csvwToDataset", async () => {
    const out = (await exportDataset(simpleDataset(), {
      to: "csvw",
    })) as { csv: string; metadata: unknown };
    const result = await csvwToDataset(out.csv, out.metadata as any);
    expectValuesEqual(simpleDataset(), result);
  });

  it("round-trips a 1-dimension dataset through CSVW", async () => {
    const out = (await exportDataset(orderDataset(), {
      to: "csvw",
    })) as { csv: string; metadata: unknown };
    const result = await csvwToDataset(out.csv, out.metadata as any);
    expectValuesEqual(orderDataset(), result);
  });
});

// ---------------------------------------------------------------------------
// Parquet export round-trip (requires parquet-wasm peer dep)
// ---------------------------------------------------------------------------

describe("Export round-trip: Parquet", () => {
  // Build IR once; reuse across codec cases so each test only pays the
  // export cost for the codec under test.
  async function obsFromSimple() {
    const { readDataset } = await import("../src/core/cubeReader");
    return readDataset(simpleDataset(), { dropNulls: false });
  }

  it("reproduces values via cubeToParquet → parquetToDataset", async () => {
    const { cubeToParquet } = await import("../src/sources/parquet");
    const bytes = await cubeToParquet(await obsFromSimple());
    const result = await parquetToDataset(bytes);
    expectValuesEqual(simpleDataset(), result);
  });

  // Compression codec round-trips. Each codec is written via the real
  // parquet-wasm WriterPropertiesBuilder path (not an options bag) and must
  // survive a write → read cycle. Codecs available in the default
  // parquet-wasm@0.6 build are exercised; unavailable ones are skipped.
  for (const codec of ["uncompressed", "snappy", "gzip", "zstd"]) {
    it(`round-trips with compression=${codec}`, async () => {
      const { cubeToParquet, ParquetSourceError } = await import(
        "../src/sources/parquet"
      );
      let bytes: Uint8Array;
      try {
        bytes = await cubeToParquet(await obsFromSimple(), {
          compression: codec,
        });
      } catch (e) {
        // Codec absent from this parquet-wasm build — skip rather than fail.
        if (e instanceof ParquetSourceError && /not available/.test(e.message)) {
          return;
        }
        throw e;
      }
      const result = await parquetToDataset(bytes);
      expectValuesEqual(simpleDataset(), result);
    });
  }

  it("accepts case-insensitive codec names (e.g. 'SNAPPY')", async () => {
    const { cubeToParquet } = await import("../src/sources/parquet");
    const bytes = await cubeToParquet(await obsFromSimple(), {
      compression: "SNAPPY",
    });
    const result = await parquetToDataset(bytes);
    expectValuesEqual(simpleDataset(), result);
  });

  it("rejects an unknown codec with a clear error", async () => {
    const { cubeToParquet, ParquetSourceError } = await import(
      "../src/sources/parquet"
    );
    await expect(
      cubeToParquet(await obsFromSimple(), { compression: "lzma" }),
    ).rejects.toThrow(ParquetSourceError);
    await expect(
      cubeToParquet(await obsFromSimple(), { compression: "lzma" }),
    ).rejects.toThrow(/Unknown compression codec "lzma"/);
  });
});
