/**
 * Example: Export a JSON-stat dataset to columnar formats (Node).
 *
 * Run:
 *   npm install jsonstat-io apache-arrow parquet-wasm
 *   node examples/node-export-parquet.mjs ./data.jsonstat.json ./out.parquet
 *
 * This demonstrates the EXPORT direction (Phase 2):
 *   JSON-stat Dataset → readDataset → Observations IR → cubeToArrow → Parquet bytes
 *
 * The same IR → Arrow path also serves DuckDB and Polars via their respective
 * `cubeToDuckdb` / `cubeToPolars` adapters.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tableToIPC } from "apache-arrow";
import { exportDataset } from "jsonstat-io";

const inputPath = process.argv[2];
const outputPath = process.argv[3] ?? "./out.parquet";
const target = process.argv[4] ?? "parquet"; // "parquet" | "arrow" | "csv" | "csvw"

if (!inputPath) {
  console.error(
    "Usage: node node-export-parquet.mjs <input.jsonstat.json> [output] [target]",
  );
  console.error("  target: parquet (default), arrow, csv, csvw");
  process.exit(2);
}

async function main() {
  // 1. Load the JSON-stat dataset.
  const jsonText = readFileSync(inputPath, "utf8");
  const dataset = JSON.parse(jsonText);

  console.log(`Loaded JSON-stat dataset: ${dataset.id?.join(", ") ?? "(unknown)"}`);

  if (target === "parquet") {
    // 2a. JSON-stat → Parquet bytes (via Arrow hub).
    //     parquet-wasm needs its WASM binary initialized in Node too.
    const bytes = await exportDataset(dataset, {
      to: "parquet",
      init: async () => {
        const wasm = await import("parquet-wasm");
        if (typeof wasm.init === "function") await wasm.init();
      },
    });

    writeFileSync(outputPath, bytes);
    console.log(`\nWrote ${bytes.length} bytes of Parquet to ${outputPath}`);
  } else if (target === "arrow") {
    // 2b. JSON-stat → Arrow Table → IPC bytes.
    const table = await exportDataset(dataset, { to: "arrow" });
    const ipcBytes = tableToIPC(table, "stream");

    writeFileSync(outputPath, ipcBytes);
    console.log(`\nWrote Arrow IPC to ${outputPath}`);
    console.log(`Table: ${table.numRows} rows × ${table.numCols} columns`);
  } else if (target === "csv") {
    // 2c. JSON-stat → CSV text.
    const csv = await exportDataset(dataset, { to: "csv" });
    writeFileSync(outputPath, csv, "utf8");
    console.log(`\nWrote CSV to ${outputPath}`);
    console.log(`\n--- First 5 lines ---`);
    console.log(csv.split("\n").slice(0, 5).join("\n"));
  } else if (target === "csvw") {
    // 2d. JSON-stat → CSV text + CSVW metadata.
    const { csv, metadata } = await exportDataset(dataset, { to: "csvw" });
    const base = outputPath.replace(/\.csvw$/i, "");
    writeFileSync(`${base}.csv`, csv, "utf8");
    writeFileSync(`${base}-metadata.json`, JSON.stringify(metadata, null, 2), "utf8");
    console.log(`\nWrote ${base}.csv + ${base}-metadata.json`);
  } else {
    console.error(`Unknown target "${target}". Use: parquet, arrow, csv, csvw.`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
