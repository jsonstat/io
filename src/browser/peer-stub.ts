/**
 * Browser-bundle stub for the optional peer packages pulled in by the
 * dynamically-imported source adapters
 * ([`parquet`](../sources/parquet.ts) → `parquet-wasm`,
 * [`duckdb`](../sources/duckdb.ts) → `@duckdb/duckdb-wasm` / `duckdb-async`,
 * [`polars`](../sources/polars.ts) → `nodejs-polars`).
 *
 * The slim IIFE browser bundle (see [`tsup.config.ts`](../../tsup.config.ts),
 * `browserConfig`) cannot code-split, so a dynamic `import("parquet-wasm")`
 * would otherwise inline the package's WASM-bindgen glue (~400 KB) even though
 * it is never callable from a browser. The build aliases each optional peer
 * package to this module, so the dynamic imports resolve to a stub that throws
 * a clear error when invoked.
 *
 * The adapters' own lazy loaders (`loadParquetWasm`, …) already wrap these
 * imports in try/catch and rethrow a friendly "not installed" message, so the
 * end-user error path is identical to the Node-without-peer case.
 */

// A no-op default export plus a Proxy that throws on any property access.
// This satisfies both `import mod from "parquet-wasm"` and
// `const { readParquet } = await import("parquet-wasm")` patterns without
// ever executing real peer code.
const STUB_ERROR = new Error(
  "jsonstat-io (browser bundle): this optional peer package is not bundled. " +
    "Use the ESM build (e.g. via esm.sh) with the peer installed.",
);

const proxy: unknown = new Proxy(
  function _jsonstatIoPeerStub() {
    throw STUB_ERROR;
  },
  {
    get() {
      throw STUB_ERROR;
    },
    apply() {
      throw STUB_ERROR;
    },
    construct() {
      throw STUB_ERROR;
    },
  },
);

export default proxy;
export const readParquet = proxy;
export const writeParquet = proxy;
export const __wbg_init = proxy;
