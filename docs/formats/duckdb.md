# DuckDB Format

Run a SQL query against DuckDB and convert the result (an Arrow table) to JSON-stat via the [Arrow hub](./arrow.md). On export, register an Arrow-backed view or table into a DuckDB connection. Two optional peer backends are supported:

- **Node**: [`duckdb-async`](https://github.com/mortonreddy/duckdb-async) — native binding.
- **Browser**: [`@duckdb/duckdb-wasm`](https://github.com/duckdb/duckdb-wasm) — WASM.

## Install

```sh
# Node
npm install jsonstat-io duckdb-async

# Browser
npm install jsonstat-io @duckdb/duckdb-wasm
```

Both are **optional peer dependencies**. The DuckDB adapter is **not** available via the CLI for import — it requires a live connection, so use the programmatic API.

## Import path

```ts
import { duckdbToCube, duckdbToDataset, openDuckdbNode } from "jsonstat-io/duckdb";
```

## Node example

```ts
import { duckdbToDataset, openDuckdbNode } from "jsonstat-io/duckdb";

const conn = await openDuckdbNode("./warehouse.duckdb");
const dataset = await duckdbToDataset(conn, 
  "SELECT year, country, amount FROM sales WHERE year >= 2020",
  { roles: { time: ["year"], geo: ["country"] } }
);
```

`openDuckdbNode(path?)` is a convenience helper that lazily imports `duckdb-async` and returns a `DuckdbConnection`. Pass `":memory:"` (the default) for an in-memory database.

## Browser example

Set up `@duckdb/duckdb-wasm` yourself, then pass the connection:

```ts
import * as duckdb from "@duckdb/duckdb-wasm";
import { duckdbToDataset } from "jsonstat-io/duckdb";

// Standard duckdb-wasm bootstrap (see their docs for full setup)
const bundle = await duckdb.selectBundle(duckdb.getBundle());
const worker = new Worker(bundle.mainWorker);
const db = new duckdb.AsyncDuckDB(logger, worker);
await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
const conn = await db.connect();

const dataset = await duckdbToDataset(conn, "SELECT * FROM sales");
```

The adapter normalizes both `duckdb-async` and `duckdb-wasm` connection shapes — it looks for `.arrow()` or `.arrowResult()` methods.

## Connection factory

For lazy browser setups, pass a `connect` factory instead of a live connection. The adapter opens and closes it automatically:

```ts
const obs = await duckdbToCube(null, query, {
  connect: async () => await createConnection(),
});
```

## Export path

[`cubeToDuckdb`](../../src/sources/duckdb.ts) converts the `Observations` IR to an Arrow table (via `cubeToArrow`) and registers it as a named view or table in the DuckDB connection.

```ts
import { exportDataset } from "jsonstat-io";

// JSON-stat → Arrow-backed view in DuckDB
const table = await exportDataset(dataset, {
  to: "duckdb",
  connection: conn,
  tableName: "sales",
  mode: "view",  // or "table" to materialize
});
```

Or use `cubeToDuckdb` directly on the IR:

```ts
import { cubeToDuckdb } from "jsonstat-io/duckdb";

await cubeToDuckdb(conn, obs, { tableName: "sales", mode: "view" });

// Now queryable in DuckDB:
const result = await conn.arrow("SELECT * FROM sales WHERE amount > 100");
```

### Export modes

| Mode   | Behavior |
|--------|----------|
| `"view"` (default) | Registers a temporary Arrow-backed view — fast, zero-copy, lives for the connection's lifetime. |
| `"table"` | Materializes the Arrow data into a persistent DuckDB table via `CREATE TABLE ... AS SELECT * FROM <view>`. |

## Options

### `DuckdbToCubeOptions` (import)

Extends [`ArrowToCubeOptions`](./arrow.md):

| Field    | Type                            | Description |
|----------|---------------------------------|-------------|
| `connect`| `() => Promise<DuckdbConnection>` | Factory that returns a fresh connection (browser). Takes precedence over `connection`, closed after use. |
| `measure`| `string`                        | Measure column name |
| `dimensions` | `string[]`                 | Dimension column names |
| `roles`  | `RoleMap`                       | Role assignments |

### `CubeToDuckdbOptions` (export)

| Field       | Type                      | Default   | Description |
|-------------|---------------------------|-----------|-------------|
| `tableName` | `string`                  | `"data"`  | Name of the view/table to create. |
| `mode`      | `"view" \| "table"`       | `"view"`  | Register a zero-copy view or materialize a table. |

## DuckdbConnection interface

```ts
interface DuckdbConnection {
  arrow(query: string): Promise<any>;  // Returns an Apache Arrow Table
  close?(): Promise<void>;
  // Export-side (registered by cubeToDuckdb):
  register?(name: string, table: any): Promise<void>;
  insert_arrow_table?(table: any, name: string): Promise<void>;
  run?(sql: string): Promise<void>;
}
```

Both `duckdb-async` and `@duckdb/duckdb-wasm` connections satisfy this interface. If your connection uses `arrowResult()` instead of `arrow()`, the adapter handles that too.

## How it works

**Import:**
1. `duckdbToCube` runs the SQL query via `conn.arrow(query)` (or `arrowResult()`).
2. Gets back an Apache Arrow `Table`.
3. Passes it to `arrowToCube` → `Observations` IR.

**Export:**
1. `cubeToDuckdb` calls `cubeToArrow(obs)` → Apache Arrow `Table`.
2. Registers the table into the connection via `conn.register(name, table)` (or `insert_arrow_table`).
3. For `mode: "table"`, runs `CREATE TABLE <name> AS SELECT * FROM <tmpview>`.

If neither DuckDB package is installed, a `DuckdbSourceError` is thrown.
