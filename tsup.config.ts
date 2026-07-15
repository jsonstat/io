import { defineConfig, type Options } from "tsup";
import path from "node:path";

/**
 * Absolute path to the [`arrow-global`](./src/browser/arrow-global.ts) shim,
 * which reads the UMD global injected by the separate apache-arrow `<script>`
 * CDN tag. Fed to esbuild's `alias` option in the browser config below so that
 * every `import … from "apache-arrow"` resolves to the already-loaded
 * `globalThis.Arrow` instead of bundling the library.
 */
const ARROW_GLOBAL = path.resolve("src/browser/arrow-global.ts");

/**
 * Absolute path to the [`peer-stub`](./src/browser/peer-stub.ts) module, which
 * throws when accessed. The browser config aliases the four optional peer
 * packages to it so their heavy WASM/native glue is never inlined into the
 * single-file IIFE (the adapters' own lazy loaders rethrow a friendly error).
 */
const PEER_STUB = path.resolve("src/browser/peer-stub.ts");

/** Shared library options (ESM + CJS, .d.ts, splitting, Node-neutral). */
const libraryConfig: Options = {
  entry: {
    index: "src/index.ts",
    "arrow/index": "src/arrow/index.ts",
    "sources/parquet": "src/sources/parquet.ts",
    "sources/duckdb": "src/sources/duckdb.ts",
    "sources/polars": "src/sources/polars.ts",
    "sources/csvw": "src/sources/csvw.ts",
    "sources/csv": "src/sources/csv.ts",
    "sources/csvstat": "src/sources/csvstat.ts",
    "sources/datapackage": "src/sources/datapackage.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  treeshake: true,
  sourcemap: true,
  // The library build runs first and owns `clean`; the browser build appends.
  clean: true,
  target: "es2020",
  platform: "neutral",
  external: [
    "apache-arrow",
    "parquet-wasm",
    "@duckdb/duckdb-wasm",
    "duckdb-async",
    "nodejs-polars",
    "commander",
  ],
  // No global shebang banner: tsup preserves the `#!/usr/bin/env node`
  // shebang from `src/cli/index.ts` only in the CLI output. A global banner
  // would either double-shebang the CLI (parse error) or place a stray
  // hashbang on library chunks.
};

/**
 * Slim standalone browser bundle — a single IIFE exposing the global
 * `JSONstatIo`, with apache-arrow loaded separately as a UMD global (the
 * two-tag pattern documented in the README §"Browser / CDN").
 *
 * - Entry is the main barrel ([`src/index.ts`](./src/index.ts)), so the same
 *   public API is available on `window.JSONstatIo`.
 * - `apache-arrow` is redirected to [`arrow-global`](./src/browser/arrow-global.ts),
 *   which reads `globalThis.Arrow` instead of bundling the library.
 * - Optional peers (parquet/duckdb/polars) are external: they are only reached
 *   via dynamic `import()` in their switch cases, so they stay as runtime
 *   dynamic imports and cost nothing until (never) invoked in a browser.
 * - `node:fs` is dynamically imported (browser-guarded) in
 *   [`fetch.ts`](./src/util/fetch.ts) and never runs in the browser.
 */
const browserConfig: Options = {
  entry: { "browser/jsonstat-io": "src/index.ts" },
  // IIFE output → `dist/browser/jsonstat-io.global.js`
  format: ["iife"],
  globalName: "JSONstatIo",
  dts: false,
  splitting: false,
  treeshake: true,
  sourcemap: true,
  clean: false,
  target: "es2020",
  platform: "browser",
  // No externals: the alias map below redirects every bare specifier the
  // IIFE needs (apache-arrow → UMD global; optional peers → throwing stub).
  external: [],
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      // apache-arrow → already-loaded UMD global (two-tag pattern).
      "apache-arrow": ARROW_GLOBAL,
      // Optional peers → throwing stub; their adapters' lazy loaders rethrow
      // a friendly "not installed" error, identical to the Node-without-peer
      // case.
      "parquet-wasm": PEER_STUB,
      "@duckdb/duckdb-wasm": PEER_STUB,
      "duckdb-async": PEER_STUB,
      "nodejs-polars": PEER_STUB,
    };
  },
};

export default defineConfig([libraryConfig, browserConfig]);
