/**
 * Polars adapter — `jsonstat-io/polars`.
 *
 * **Import:** accepts a Polars `DataFrame` (from `nodejs-polars`) and funnels
 * its Arrow representation through the Arrow hub
 * ([`arrowToCube`](../arrow/arrowToCube.ts)).
 *
 * **Export:** [`cubeToPolars`] builds an Arrow [`Table`] from the
 * [`Observations`] IR and converts it back to a Polars `DataFrame`.
 *
 * ## Node-only
 *
 * `nodejs-polars` is a native Node module — it cannot run in the browser. For
 * browser Polars data, convert to Arrow IPC first and use
 * `jsonstat-io/arrow` directly. This adapter is therefore documented as
 * **Node-only**; importing it in a browser bundle will fail at runtime (the
 * `nodejs-polars` import is lazy, so the failure only happens on use).
 */

import type { Table } from "apache-arrow";
import { cubeToArrow } from "../arrow/arrowFromCube";
import { type ArrowToCubeOptions, arrowToCube } from "../arrow/arrowToCube";
import type { Observations } from "../model/ir";
import type { JsonStatDataset } from "../model/jsonstat";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PolarsSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolarsSourceError";
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PolarsToCubeOptions extends ArrowToCubeOptions {
  /**
   * Polars frames expose different Arrow conversion methods across versions
   * (`toArrow()`, `toIPC()`, etc.). The adapter tries them in order; this
   * option forces a specific one. Usually unnecessary.
   */
  arrowMethod?: "toArrow" | "toIPC" | "auto";
}

/**
 * Structural surface of a `nodejs-polars` `DataFrame` as used by this adapter.
 * `nodejs-polars` is an optional peer with a heavy native binding; we model
 * only the conversion methods we probe for, so callers can pass any object with
 * a compatible shape without a hard static dependency.
 */
export interface PolarsDataFrame {
  toArrow?(): Table | Promise<Table>;
  toIPC?(): Uint8Array | ArrayBuffer | Promise<Uint8Array | ArrayBuffer>;
  [method: string]: unknown;
}

/**
 * Structural surface of the `nodejs-polars` module (`pl`): the constructors we
 * call when building a DataFrame from an Arrow Table.
 */
export interface PolarsModule {
  fromArrow?(table: Table): PolarsDataFrame | Promise<PolarsDataFrame>;
  readIPC?(buf: Uint8Array | ArrayBuffer): PolarsDataFrame | Promise<PolarsDataFrame>;
}

// ---------------------------------------------------------------------------
// Internal: lazy nodejs-polars-free Arrow extraction
// ---------------------------------------------------------------------------

/**
 * Extract an Arrow Table from a Polars DataFrame. Tries the common conversion
 * methods. We do NOT statically import `nodejs-polars` — the caller passes a
 * DataFrame object, keeping this module free of a hard dependency.
 */
async function polarsToArrow(
  df: PolarsDataFrame,
  method: PolarsToCubeOptions["arrowMethod"],
): Promise<Table | undefined> {
  const tried: string[] = [];
  const tryMethod = async (name: "toArrow" | "toIPC"): Promise<unknown> => {
    const fn = df[name];
    if (typeof fn !== "function") {
      tried.push(name);
      return undefined;
    }
    return await (fn as (...args: unknown[]) => unknown).call(df);
  };

  if (method === "toArrow" || method === "auto" || method === undefined) {
    const t = await tryMethod("toArrow");
    if (t) return t as Table;
  }
  if (method === "toIPC" || method === "auto" || method === undefined) {
    const ipc = await tryMethod("toIPC");
    if (ipc) {
      // IPC bytes → Arrow Table via apache-arrow's readIPC (lazy import).
      const { tableFromIPC } = await import("apache-arrow");
      return tableFromIPC(ipc as unknown as Parameters<typeof tableFromIPC>[0]) as Table;
    }
  }

  throw new PolarsSourceError(
    `Could not obtain an Arrow Table from the Polars DataFrame (tried: ${tried.join(", ")}). Ensure nodejs-polars is installed and the DataFrame supports toArrow()/toIPC().`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a Polars `DataFrame` to the [`Observations`] IR via the Arrow hub.
 *
 * @param df A Polars DataFrame (`nodejs-polars`). Not statically typed to avoid
 *        a hard dependency; pass any object exposing `toArrow()`/`toIPC()`.
 * @throws [`PolarsSourceError`] if Arrow extraction fails.
 */
export async function polarsToCube(
  df: PolarsDataFrame,
  options: PolarsToCubeOptions = {},
): Promise<Observations> {
  const table = await polarsToArrow(df, options.arrowMethod ?? "auto");
  if (!table) throw new PolarsSourceError("Polars DataFrame yielded no Arrow table");
  return arrowToCube(table, options);
}

/** Convenience: Polars DataFrame → JSON-stat [`Dataset`]. */
export async function polarsToDataset(
  df: PolarsDataFrame,
  options?: PolarsToCubeOptions,
): Promise<JsonStatDataset> {
  const { toDataset } = await import("../core/cubeBuilder");
  return toDataset(await polarsToCube(df, options));
}

/**
 * Lazily load `nodejs-polars`. Exposed so callers can `readCSV`/`readParquet`
 * via Polars without a direct import in their own code.
 */
export async function loadPolars(): Promise<PolarsModule> {
  try {
    return (await import("nodejs-polars")) as unknown as PolarsModule;
  } catch {
    throw new PolarsSourceError(
      "nodejs-polars is not installed. Install it with `npm i nodejs-polars` (Node only).",
    );
  }
}

// ---------------------------------------------------------------------------
// Export: Observations IR → Polars DataFrame
// ---------------------------------------------------------------------------

export interface CubeToPolarsOptions {
  /**
   * Conversion path from Arrow to Polars. `"fromArrow"` (default) uses
   * `pl.fromArrow(table)`; `"ipc"` serializes the table to Arrow IPC and reads
   * it via `pl.readIPC(buf)`. Usually unnecessary; `"auto"` tries `"fromArrow"`
   * first, then `"ipc"`.
   */
  method?: "fromArrow" | "ipc" | "auto";
}

/**
 * Convert an Arrow [`Table`] to a Polars `DataFrame`. Tries the common
 * nodejs-polars constructors in order. Extracted so [`cubeToPolars`] and the
 * round-trip tests share one path.
 *
 * @internal
 */
export async function arrowToPolars(
  table: Table,
  method: CubeToPolarsOptions["method"] = "auto",
): Promise<PolarsDataFrame> {
  const pl = await loadPolars();
  const tried: string[] = [];

  if (method === "fromArrow" || method === "auto") {
    tried.push("pl.fromArrow");
    if (typeof pl.fromArrow === "function") {
      try {
        return await pl.fromArrow(table);
      } catch {
        // fall through to ipc
      }
    }
  }

  if (method === "ipc" || method === "auto") {
    tried.push("pl.readIPC");
    // Serialize the Arrow Table to IPC stream bytes, then read via Polars.
    const { tableToIPC } = await import("apache-arrow");
    const buf = tableToIPC(table, "stream");
    if (typeof pl.readIPC === "function") {
      try {
        return await pl.readIPC(buf);
      } catch {
        // fall through
      }
    }
  }

  throw new PolarsSourceError(
    `Could not build a Polars DataFrame from the Arrow Table (tried: ${tried.join(", ")}). Ensure nodejs-polars is installed and supports fromArrow()/readIPC().`,
  );
}

/**
 * Write the [`Observations`](../model/ir.ts) IR to a Polars `DataFrame`.
 *
 * The IR is first converted to an Arrow [`Table`] via [`cubeToArrow`], then
 * handed to `nodejs-polars` (`pl.fromArrow`). All `jsonstat.*` schema/field
 * metadata travels on the Arrow schema; Polars preserves it through the Arrow
 * IPC pathway, so a subsequent `df.toArrow()` → [`arrowToCube`] round-trips.
 *
 * Node-only: this function dynamically imports `nodejs-polars` and will throw
 * [`PolarsSourceError`] in the browser.
 *
 * @returns A Polars `DataFrame` (`nodejs-polars`).
 * @throws [`PolarsSourceError`] if nodejs-polars is missing or the conversion fails.
 *
 * @example
 * ```ts
 * import { cubeToPolars } from "jsonstat-io/polars";
 * const df = await cubeToPolars(observations);
 * console.log(df.shape);
 * ```
 */
export async function cubeToPolars(
  obs: Observations,
  options: CubeToPolarsOptions = {},
): Promise<PolarsDataFrame> {
  const table = cubeToArrow(obs);
  return arrowToPolars(table, options.method);
}
