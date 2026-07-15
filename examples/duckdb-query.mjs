/**
 * Example: Query DuckDB and import the result into JSON-stat (Node).
 *
 * Run:
 *   npm install jsonstat-io duckdb-async
 *   node examples/duckdb-query.mjs
 *
 * This demonstrates the DuckDB → Arrow → JSON-stat flow:
 *   SQL query → conn.arrow() → arrowToCube → buildDataset → JSON-stat Dataset
 *
 * DuckDB reads Parquet, CSV, Arrow, and JSON natively, so you can use it as a
 * universal adapter — query any format, get JSON-stat out.
 */

import { writeFile } from "node:fs/promises";
import { duckdbToDataset, openDuckdbNode, serialize } from "jsonstat-io/duckdb";

async function main() {
  // 1. Open an in-memory DuckDB database.
  //    Pass a file path (e.g. "./warehouse.duckdb") for persistence.
  const conn = await openDuckdbNode(":memory:");

  try {
    // 2. Load some sample data.
    //    DuckDB can read Parquet, CSV, Arrow, JSON, etc. directly from SQL.
    //    Here we create a table inline for a self-contained example.
    await conn.arrow(`
      CREATE TABLE sales AS
      SELECT * FROM (VALUES
        (2020, 'Spain',  100.0, 'p'),
        (2020, 'France', 200.0, 'p'),
        (2021, 'Spain',  150.0, 'e'),
        (2021, 'France', 250.0, 'e')
      ) AS t(year, country, amount, status_flag)
    `);

    // 3. Run a query and convert the result to JSON-stat.
    //    The query must return dimension columns + exactly one measure column.
    const dataset = await duckdbToDataset(
      conn,
      "SELECT year, country, amount, status_flag FROM sales ORDER BY year, country",
      {
        // Map the status_flag column to the JSON-stat status:
        status: "status_flag",
        // Assign roles:
        roles: { time: ["year"], geo: ["country"] },
        // Force dense value form:
        build: { valueForm: "dense", statusForm: "array" },
      },
    );

    // 4. Serialize to canonical JSON.
    const json = serialize(dataset, { pretty: true, canonicalKeys: true });

    console.log("--- JSON-stat output ---");
    console.log(json);

    // 5. Optionally write to a file.
    await writeFile("./sales.jsonstat.json", json, "utf8");
    console.log("\nWrote sales.jsonstat.json");

    // Print a summary.
    console.log("\n--- Cube summary ---");
    console.log(`Dimensions: ${dataset.id.join(", ")}`);
    console.log(
      `Size: ${dataset.size.join(" × ")} = ${dataset.size.reduce((a, b) => a * b, 1)} cells`,
    );
    console.log(`Roles: ${JSON.stringify(dataset.role)}`);
    console.log(`Value form: ${Array.isArray(dataset.value) ? "dense" : "sparse"}`);
    console.log(`Status: ${JSON.stringify(dataset.status)}`);
  } finally {
    // Always close the connection.
    if (conn.close) await conn.close();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
