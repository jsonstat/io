/**
 * Observations IR — the format-agnostic intermediate representation.
 *
 * Every source (Arrow, Parquet, DuckDB, Polars, CSVW, CSV) converts its data
 * into this IR. The cube builder ([`CubeBuilder`](../core/cubeBuilder.ts))
 * then turns the IR into a JSON-stat [`Dataset`](./jsonstat.ts).
 *
 * The IR is deliberately a **long / tidy table**: one row per observation,
 * with one column per dimension and a single measure column. This is the
 * natural shape of the columnar stack and the dual of a JSON-stat cube.
 *
 * Because the IR is bidirectional, the same model also powers the Phase-2
 * export path ([`cubeReader`](../core/cubeReader.ts) → IR →
 * [`arrowFromCube`](../arrow/arrowFromCube.ts) → Arrow/Parquet/CSV). See
 * [docs/architecture.md](../../docs/architecture.md) §"The two documented seams".
 */

import type { JsonStatRole, JsonStatUnit } from "./jsonstat";

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * A dimension column: the observed category *labels or IDs* for each row.
 *
 * `values` is a parallel array (one entry per observation) of category IDs.
 * Category order is *not* implied here — it is resolved by the builder, which
 * enumerates distinct values and assigns indices. Use `categoryOrder` to pin
 * a specific order (e.g. chronological time) when the source knows it.
 */
export interface DimensionColumn {
  /** Dimension ID (becomes a key in JSON-stat `dimension`). */
  id: string;
  /** Human-readable dimension label. */
  label?: string;
  /** Per-row category ID. `null` is not permitted for dimensions. */
  values: string[];
  /**
   * Optional explicit category ordering. When omitted the builder enumerates
   * distinct values in first-seen order. Provide for time dimensions whose
   * chronological order is not lexicographic.
   */
  categoryOrder?: string[];
  /** ID → human-readable category label. Falls back to the ID. */
  categoryLabels?: Record<string, string>;
  /** ID → unit metadata (metric-role dimensions only). */
  categoryUnits?: Record<string, JsonStatUnit>;
  /** ID → [lon, lat] (geo-role dimensions only). */
  categoryCoordinates?: Record<string, [number, number]>;
  /** Parent ID → direct child IDs (hierarchical dimensions only). */
  categoryChild?: Record<string, string[]>;
  /** Optional href to an external dimension definition. */
  href?: string;
}

/**
 * The measure column: the numeric observation values, one per row.
 *
 * `null` represents a missing observation. The importer supports a single
 * measure column in v0.1 — multi-measure datasets should be split across
 * multiple datasets (one per metric) or modeled as a metric *dimension*,
 * matching how JSON-stat treats measures as a dimension with the `metric`
 * role rather than as separate value arrays.
 */
export interface MeasureColumn {
  /** Column name in the source (kept for round-trip fidelity, not emitted). */
  name?: string;
  /** Numeric values; `null` = missing. */
  values: (number | null)[];
}

/**
 * Optional per-row status column. Provider-defined vocabulary; emitted verbatim
 * as JSON-stat `status` (array form) by the builder.
 */
export interface StatusColumn {
  /** Per-row status code. */
  values: string[];
}

// ---------------------------------------------------------------------------
// Roles & cube model
// ---------------------------------------------------------------------------

/**
 * Role assignment. Mirrors JSON-stat's `role` object: each role maps to a list
 * of dimension IDs. The importer assigns roles from source metadata or CLI
 * hints; unassigned dimensions default to the implicit "classification" role.
 */
export type RoleMap = JsonStatRole;

/**
 * Dataset-level metadata carried alongside the observations.
 *
 * These fields map directly to top-level JSON-stat dataset properties
 * (`label`, `source`, `updated`, `extension`).
 */
export interface DatasetMeta {
  label?: string;
  source?: string;
  updated?: string;
  extension?: Record<string, unknown>;
}

/**
 * The complete cube model: everything the builder needs besides the raw
 * observation columns to produce a fully-specified JSON-stat dataset.
 */
export interface CubeModel {
  /** Ordered dimension IDs. Determines row-major stride order. */
  dimensionIds: string[];
  /** Role assignments (time/geo/metric). */
  roles?: RoleMap;
  /** Dataset-level metadata. */
  meta?: DatasetMeta;
  /**
   * How to emit `value`.
   * - "auto": dense unless null-ratio exceeds `sparseThreshold`.
   * - "dense": always array form.
   * - "sparse": always object form.
   */
  valueForm?: "auto" | "dense" | "sparse";
  /** Null ratio above which "auto" chooses sparse. Default 0.5. */
  sparseThreshold?: number;
  /**
   * Whether to emit a status array. When a StatusColumn is present and this is
   * not "none", the builder emits status. "object" emits the sparse object form
   * when there are few non-default statuses; "string" collapses a uniform
   * status to a single string.
   */
  statusForm?: "auto" | "array" | "string" | "object" | "none";
}

// ---------------------------------------------------------------------------
// The IR
// ---------------------------------------------------------------------------

/**
 * The Observations IR: a tidy long table plus its cube model.
 *
 * Invariants the builder assumes (validated in [`CubeBuilder.build`]):
 * - All columns in `dimensions` and `measure` share the same length `n`.
 * - `status`, if present, has length `n`.
 * - `model.dimensionIds` lists every dimension column id, and no others.
 * - No dimension value is `null` or `undefined`.
 */
export interface Observations {
  /** Dimension columns, keyed by dimension ID. */
  dimensions: Record<string, DimensionColumn>;
  /** The single measure column. */
  measure: MeasureColumn;
  /** Optional per-row status. */
  status?: StatusColumn;
  /** The cube model governing how to build the JSON-stat dataset. */
  model: CubeModel;
}

/** Number of observations (rows). */
export function observationCount(obs: Observations): number {
  return obs.measure.values.length;
}
