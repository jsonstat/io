/**
 * Example: Import an Arrow IPC file into JSON-stat (Node).
 *
 * Run:
 *   npm install jsonstat-io apache-arrow
 *   node examples/node-import-arrow.mjs ./data.arrow
 *
 * This demonstrates the core Arrow-hub flow:
 *   Arrow IPC bytes → tableFromIPC → arrowToDataset → JSON-stat Dataset
 *
 * For Parquet, swap tableFromIPC for `parquetToDataset` from
 * `jsonstat-io/parquet`. For DuckDB, see duckdb-query.mjs.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tableFromIPC } from "apache-arrow";
import {
  arrowToDataset,
  serialize,
} from "jsonstat-io";

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath) {
  console.error("Usage: node node-import-arrow.mjs <input.arrow> [output.jsonstat.json]");
  process.exit(2);
}

async function main() {
  // 1. Read the Arrow IPC file.
  const bytes = readFileSync(inputPath);

  // 2. Parse into an Arrow Table.
  const table = tableFromIPC(bytes);

  console.log(`Loaded Arrow table: ${table.numRows} rows × ${table.numCols} columns`);
  console.log(`Schema fields: ${table.schema.fields.map((f) => `${f.name}:${f.type}`).join(", ")}`);

  // 3. Convert to JSON-stat via the Arrow hub.
  //    Without options, arrowToDataset auto-detects the measure (first numeric
  //    column) and treats dictionary/other columns as dimensions.
  const dataset = arrowToDataset(table, {
    // Explicit hints (optional — overrides detection):
    measure: undefined,        // auto-detect
    roles: undefined,          // auto-infer from column names
    valueForm: "auto",         // auto dense/sparse by null ratio
  });

  // 4. Serialize to canonical JSON.
  const json = serialize(dataset, {
    pretty: true,
    canonicalKeys: true,
  });

  // 5. Write or print.
  if (outputPath) {
    writeFileSync(outputPath, json, "utf8");
    console.log(`\nWrote JSON-stat to ${outputPath}`);
  } else {
    console.log("\n--- JSON-stat output ---");
    console.log(json);
  }

  // Print a summary of the resulting cube.
  console.log(`\n--- Cube summary ---`);
  console.log(`Dimensions: ${dataset.id.join(", ")}`);
  console.log(`Size: ${dataset.size.join(" × ")} = ${dataset.size.reduce((a, b) => a * b, 1)} cells`);
  console.log(`Roles: ${JSON.stringify(dataset.role)}`);
  console.log(`Value form: ${Array.isArray(dataset.value) ? "dense (array)" : "sparse (object)"}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
