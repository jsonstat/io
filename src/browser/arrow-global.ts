/**
 * Browser-only shim that bridges `import … from "apache-arrow"` to the UMD
 * global injected by the standalone `<script>` CDN tag.
 *
 * The slim IIFE browser bundle (see [`tsup.config.ts`](../../tsup.config.ts),
 * `browser` config) aliases the bare specifier `"apache-arrow"` to this module
 * via esbuild's `alias` option, so that every `import { Table, … } from
 * "apache-arrow"` in the library resolves to the **already-loaded**
 * `globalThis.Arrow` provided by the separate apache-arrow `<script>` tag —
 * the two-tag pattern documented in the [README](../../README.md) §"Browser /
 * CDN".
 *
 * The named surface below is the exact set of apache-arrow symbols imported
 * anywhere in the library. esbuild validates that every static
 * `import { X } from "apache-arrow"` has a matching `export const X` here, so
 * this list must stay in sync with new apache-arrow imports. The current set
 * comes from:
 *  - [`arrowToCube`](../arrow/arrowToCube.ts), [`arrowFromCube`](../arrow/arrowFromCube.ts),
 *    [`schemaMeta`](../arrow/schemaMeta.ts) (the arrow hub).
 *  - [`index.ts`](../index.ts) (`tableFromIPC`).
 *  - [`parquet.ts`](../sources/parquet.ts) and [`cli/index.ts`](../cli/index.ts)
 *    (`tableToIPC`), which are inlined into the IIFE.
 *
 * This module is never imported by the Node/ESM/CJS builds (it is only reached
 * through the build-time alias), so it carries no runtime cost outside the
 * browser bundle.
 */

const _g = globalThis as unknown as Record<string, Record<string, unknown>>;
const Arrow = _g.Arrow;

if (!Arrow) {
  throw new Error(
    "jsonstat-io (browser bundle): the apache-arrow UMD global was not found. " +
      'Load it first, e.g. <script src="https://cdn.jsdelivr.net/npm/apache-arrow@17"></script>. ' +
      'See README §"Browser / CDN" for the two-tag pattern.',
  );
}

// --- Classes / type values used across the arrow hub ------------------------
export const DataType = Arrow.DataType;
export const Field = Arrow.Field;
export const Schema = Arrow.Schema;
export const Table = Arrow.Table;
export const Vector = Arrow.Vector;

// Concrete data types.
export const Utf8 = Arrow.Utf8;
export const Dictionary = Arrow.Dictionary;
export const Int32 = Arrow.Int32;
export const Int64 = Arrow.Int64;
export const Float64 = Arrow.Float64;
export const Float32 = Arrow.Float32;
export const Bool = Arrow.Bool;
export const DateDay = Arrow.DateDay;
export const DateMillisecond = Arrow.DateMillisecond;
export const TimestampSecond = Arrow.TimestampSecond;
export const TimestampMillisecond = Arrow.TimestampMillisecond;

// --- Factory functions ------------------------------------------------------
export const vectorFromArray = Arrow.vectorFromArray;
export const makeVector = Arrow.makeVector;
export const tableFromIPC = Arrow.tableFromIPC;
export const tableToIPC = Arrow.tableToIPC;
