import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "arrow/index": "src/arrow/index.ts",
    "sources/parquet": "src/sources/parquet.ts",
    "sources/duckdb": "src/sources/duckdb.ts",
    "sources/polars": "src/sources/polars.ts",
    "sources/csvw": "src/sources/csvw.ts",
    "sources/csv": "src/sources/csv.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  treeshake: true,
  sourcemap: true,
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
});
