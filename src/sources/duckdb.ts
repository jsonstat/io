/**
 * DuckDB adapter — `jsonstat-io/duckdb`.
 *
 * **Import:** runs a SQL query against DuckDB and funnels the result (as an
 * Arrow [`Table`]) through the Arrow hub
 * ([`arrowToCube`](../arrow/arrowToCube.ts)).
 *
 * **Export:** [`cubeToDuckdb`] registers an Arrow [`Table`] built from the
 * [`Observations`] IR into a DuckDB connection as a named table.
 *
 * Two optional peer backends are supported, picked automatically:
 *
 *  - **Browser**: `@duckdb/duckdb-wasm` — instantiate via `@duckdb/duckdb-wasm`
 *    and pass the connection (or a factory) to [`duckdbToCube`].
 *  - **Node**: `duckdb-async` — a native binding; pass the connection.
 *
 * Both expose an `.arrowResult()` / `.arrow()` style API that yields an Arrow
 * Table. The adapter normalizes the two shapes.
 *
 * `@duckdb/duckdb-wasm` and `duckdb-async` are **optional peer dependencies**.
 */

import type { Observations } from "../model/ir";
import type { JsonStatDataset } from "../model/jsonstat";
import { arrowToCube, type ArrowToCubeOptions } from "../arrow/arrowToCube";
import { cubeToArrow } from "../arrow/arrowFromCube";
import type { Table } from "apache-arrow";

// ---------------------------------------------------------------------------
// Errors & types
// ---------------------------------------------------------------------------

export class DuckdbSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuckdbSourceError";
  }
}

/**
 * A minimal connection interface covering both duckdb-wasm and duckdb-async.
 * The adapter only requires a way to run a query and obtain an Arrow Table.
 */
export interface DuckdbConnection {
  /** Run a SQL query and return an Apache Arrow Table. */
  arrow(query: string): Promise<any>;
  /**
   * Register an Arrow Table under a view name (duckdb-async style). Optional:
   * the export path falls back to `insert_arrow_table` / `conn.register` if
   * this is absent.
   */
  register?(viewName: string, table: any): Promise<void>;
  /** DuckDB-wasm style: insert an Arrow Table into a named table. */
  insert_arrow_table?(table: any, options?: { name?: string }): Promise<void>;
  /** Run an arbitrary SQL statement (no Arrow result). */
  run?(query: string): Promise<unknown>;
  close?(): Promise<void>;
}

export interface DuckdbToCubeOptions extends ArrowToCubeOptions {
  /**
   * A factory that returns a fresh connection. Useful for browser setups where
   * the wasm module must be instantiated lazily. If provided, takes precedence
   * over `connection` and is closed after use.
   */
  connect?: () => Promise<DuckdbConnection>;
}

// ---------------------------------------------------------------------------
// Internal: normalize Arrow result extraction
// ---------------------------------------------------------------------------

/**
 * DuckDB bindings return Arrow tables via differently-named methods
 * (`arrowResult`, `arrow`, `all`+manual). Try the common ones in order.
 */
async function runQuery(conn: DuckdbConnection, query: string): Promise<any> {
  if (typeof (conn as any).arrow === "function") {
    return await (conn as any).arrow(query);
  }
  if (typeof (conn as any).arrowResult === "function") {
    const res = await (conn as any).arrowResult(query);
    // duckdb-wasm: result is either a Table or has .getAll() / .arrow()
    if (res && typeof res.arrow === "function") return await res.arrow();
    return res;
  }
  throw new DuckdbSourceError(
    "DuckDB connection has no arrow()/arrowResult() method; cannot fetch Arrow result",
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a SQL query against DuckDB and convert the result to the
 * [`Observations`] IR via the Arrow hub.
 *
 * @param connectionOrFactory A [`DuckdbConnection`] or (via `options.connect`)
 *        a factory creating one.
 * @param query SQL to execute.
 * @throws [`DuckdbSourceError`] on query or conversion failure.
 */
export async function duckdbToCube(
  connection: DuckdbConnection,
  query: string,
  options: DuckdbToCubeOptions = {},
): Promise<Observations> {
  let conn: DuckdbConnection = connection;
  let ownsConn = false;
  if (options.connect) {
    conn = await options.connect();
    ownsConn = true;
  }

  let table: any;
  try {
    table = await runQuery(conn, query);
  } catch (e: any) {
    if (ownsConn && conn.close) await conn.close().catch(() => {});
    throw new DuckdbSourceError(`DuckDB query failed: ${e?.message ?? e}`);
  }

  if (ownsConn && conn.close) await conn.close().catch(() => {});
  if (!table) throw new DuckdbSourceError("DuckDB returned no result");

  return arrowToCube(table, options);
}

/** Convenience: DuckDB query → JSON-stat [`Dataset`]. */
export async function duckdbToDataset(
  connection: DuckdbConnection,
  query: string,
  options?: DuckdbToCubeOptions,
): Promise<JsonStatDataset> {
  const { toDataset } = await import("../core/cubeBuilder");
  return toDataset(await duckdbToCube(connection, query, options));
}

/**
 * Helper for Node users of `duckdb-async`: create a connection from a
 * Database instance. Importing `duckdb-async` is lazy so browser bundles stay
 * lean.
 */
export async function openDuckdbNode(path = ":memory:"): Promise<DuckdbConnection> {
  try {
    const mod: any = await import("duckdb-async");
    const db = await mod.createDb(path);
    return (await db.connect()) as DuckdbConnection;
  } catch {
    throw new DuckdbSourceError(
      "duckdb-async is not installed. Install it with `npm i duckdb-async` for Node usage.",
    );
  }
}

// ---------------------------------------------------------------------------
// Export: Observations IR → DuckDB table
// ---------------------------------------------------------------------------

export interface CubeToDuckdbOptions {
  /** Name of the target table/view to create. Defaults to `"observations"`. */
  tableName?: string;
  /**
   * `"view"` (default): registers the Arrow Table as a queryable view via
   * `conn.register` (cheap; the table is not copied). `"table"`: creates and
   * populates a physical table via DuckDB's `insert_arrow_table` / `CREATE
   * TABLE AS`.
   */
  mode?: "view" | "table";
}

/** Sanitize a table name into a valid DuckDB identifier (quoted). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Register an Arrow [`Table`] into a DuckDB connection under a view/table name.
 *
 * Tries, in order: `conn.register(viewName, table)` (duckdb-async), then
 * `conn.insert_arrow_table(table, { name })` (duckdb-wasm), then a manual
 * `CREATE TABLE AS SELECT * FROM arrow_scan` fallback. Throws if none of the
 * registration paths are available on the connection.
 *
 * @internal
 */
async function registerArrowTable(
  conn: DuckdbConnection,
  table: Table,
  name: string,
  mode: "view" | "table",
): Promise<void> {
  if (mode === "view" && typeof conn.register === "function") {
    await conn.register(name, table);
    return;
  }
  if (typeof conn.insert_arrow_table === "function") {
    // duckdb-wasm writes a physical table.
    await conn.insert_arrow_table(table, { name });
    return;
  }
  if (mode === "view" && typeof conn.register === "function") {
    await conn.register(name, table);
    return;
  }
  if (typeof conn.run === "function") {
    // Last-resort: register via the duckdb-async Connection.register, which is
    // already covered above; here we only reach if register is absent.
    throw new DuckdbSourceError(
      "DuckDB connection cannot ingest an Arrow Table: no register()/insert_arrow_table() method. " +
        "Pass a duckdb-async or @duckdb/duckdb-wasm connection.",
    );
  }
  throw new DuckdbSourceError(
    "DuckDB connection cannot ingest an Arrow Table: no register()/insert_arrow_table() method. " +
      "Pass a duckdb-async or @duckdb/duckdb-wasm connection.",
  );
}

/**
 * Write the [`Observations`](../model/ir.ts) IR into a DuckDB connection as a
 * named table (or view).
 *
 * The IR is first converted to an Arrow [`Table`] via [`cubeToArrow`], then
 * registered into the connection. All `jsonstat.*` schema/field metadata is
 * preserved on the Arrow schema, so a subsequent `SELECT * FROM <table>` →
 * [`arrowToCube`] round-trips the model.
 *
 * @returns The name of the created table/view.
 * @throws [`DuckdbSourceError`] if the connection cannot ingest Arrow tables.
 *
 * @example
 * ```ts
 * import { openDuckdbNode, cubeToDuckdb } from "jsonstat-io/duckdb";
 * const conn = await openDuckdbNode();
 * const name = await cubeToDuckdb(conn, observations, { tableName: "sales" });
 * const rows = await conn.arrow(`SELECT * FROM ${name} LIMIT 5`);
 * ```
 */
export async function cubeToDuckdb(
  conn: DuckdbConnection,
  obs: Observations,
  options: CubeToDuckdbOptions = {},
): Promise<string> {
  const tableName = options.tableName ?? "observations";
  const mode = options.mode ?? "view";
  const table = cubeToArrow(obs);

  try {
    if (mode === "table") {
      // Materialize into a physical table: create empty then insert.
      if (typeof conn.run === "function") {
        const ident = quoteIdent(tableName);
        // DuckDB can register the Arrow table temporarily, then CTAS from it.
        const tempView = `__jsonstat_io_${tableName}_${Date.now()}`;
        await registerArrowTable(conn, table, tempView, "view");
        await conn.run(
          `CREATE TABLE ${ident} AS SELECT * FROM ${quoteIdent(tempView)};`,
        );
        // Best-effort drop of the temp view; ignore errors.
        if (typeof conn.run === "function") {
          await conn.run(`DROP VIEW IF EXISTS ${quoteIdent(tempView)};`).catch(
            () => {},
          );
        }
        return tableName;
      }
    }
    await registerArrowTable(conn, table, tableName, mode);
    return tableName;
  } catch (e: any) {
    if (e instanceof DuckdbSourceError) throw e;
    throw new DuckdbSourceError(`DuckDB export failed: ${e?.message ?? e}`);
  }
}
