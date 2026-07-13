/**
 * Example: Fetch a JSON-stat dataset from a URL and convert it to Parquet (Node).
 *
 * Run:
 *   npm install jsonstat-io apache-arrow parquet-wasm
 *   node examples/url-to-parquet.mjs [url] [output.parquet]
 *
 * Defaults:
 *   url    = https://json-stat.org/samples/canada.json
 *   output = ./canada.parquet
 *
 * This demonstrates the full EXPORT pipeline starting from a remote source:
 *   fetch(url) → JSON-stat Dataset → readDataset → Observations IR
 *              → cubeToArrow → Parquet bytes → file
 *
 * The same pattern works for any reachable JSON-stat URL (HTTPS or HTTP).
 *
 * Note: parquet-wasm's default compression is used. Some parquet-wasm versions
 * reject a plain `{ compression }` options bag (they want a `WriterProperties`
 * instance), so we leave `compression` unset here.
 */

import { writeFile } from "node:fs/promises";
import { exportDataset, serialize } from "jsonstat-io";

const DEFAULT_URL = "https://json-stat.org/samples/canada.json";
const DEFAULT_OUTPUT = "./canada.parquet";

const url = process.argv[2] ?? DEFAULT_URL;
const outputPath = process.argv[3] ?? DEFAULT_OUTPUT;

async function main() {
  // 1. Fetch the JSON-stat document.
  console.log(`Fetching ${url} ...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const dataset = await response.json();

  console.log(
    `Loaded JSON-stat dataset: ${dataset.id?.join(", ") ?? "(unknown)"} ` +
      `(${dataset.label ?? "no label"})`,
  );

  // 2. Show the cube shape before export.
  const totalCells = (dataset.size ?? []).reduce((a, b) => a * b, 1);
  console.log(
    `  size: ${(dataset.size ?? []).join(" × ")} = ${totalCells} cells; ` +
      `value form: ${Array.isArray(dataset.value) ? "dense" : "sparse"}`,
  );

  // 3. JSON-stat → Parquet bytes (via the Arrow hub).
  //    parquet-wasm needs its WASM binary initialized in Node too.
  console.log("Converting to Parquet ...");
  // NOTE: `compression` is now a real parquet-wasm WriterProperties under the
  // hood (built via WriterPropertiesBuilder). Omit it to use the default
  // (Snappy). Valid codecs: uncompressed, snappy, gzip, brotli, lz4, lz4_raw,
  // zstd, lzo — subject to parquet-wasm build availability.
  const bytes = await exportDataset(dataset, {
    to: "parquet",
    compression: "snappy",
    init: async () => {
      // parquet-wasm's ESM build exports the WASM initializer as the module's
      // DEFAULT export (not a named `init`). Prefer it; fall back to a named
      // `init` for builds that expose one. The call is idempotent.
      const wasm = await import("parquet-wasm");
      const initialize =
        typeof wasm.default === "function" ? wasm.default : wasm.init;
      if (typeof initialize === "function") await initialize();
    },
  });

  // 4. Write the Parquet bytes to disk.
  await writeFile(outputPath, bytes);
  console.log(`\nWrote ${bytes.length} bytes of Parquet to ${outputPath}`);

  // 5. Bonus: also show the canonical JSON-stat serialization of what was read,
  //    so you can eyeball that the round-trip preserves the data.
  console.log("\n--- Canonical JSON-stat (re-serialized) ---");
  console.log(serialize(dataset, { pretty: true, canonicalKeys: true }));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
