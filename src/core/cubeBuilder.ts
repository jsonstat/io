/**
 * CubeBuilder — turns an [`Observations`](../model/ir.ts) IR into a JSON-stat
 * [`Dataset`](../model/jsonstat.ts).
 *
 * This is the central transform of the importer: a tidy long table → an
 * N-dimensional cube laid out in row-major order ("what does not change, first";
 * see https://jsonstat.org/format/).
 *
 * Responsibilities:
 *  1. Resolve dimension order and enumerate categories (first-seen order unless
 *     `categoryOrder` pins it).
 *  2. Build the `dimension` block with `category.index`/`label`/`unit`/
 *     `coordinates`/`child` and dimension `label`.
 *  3. Scatter the measure values into a row-major `value` array (dense) or a
 *     sparse object, per [`CubeModel.valueForm`](../model/ir.ts) and the null
 *     ratio threshold.
 *  4. Emit `status` in the most compact correct form (string/array/object).
 *  5. Attach `role`, and dataset-level `label`/`source`/`updated`/`extension`.
 *
 * Pure: no I/O, no side effects. All index math delegated to
 * [`strides`](./strides.ts).
 */

import type {
  DatasetMeta,
  DimensionColumn,
  Observations,
} from "../model/ir";
import type {
  JsonStatCategory,
  JsonStatDataset,
  JsonStatDimension,
  JsonStatRole,
  JsonStatStatus,
  JsonStatValue,
} from "../model/jsonstat";
import { enumerateCells, flatPosition, totalCells } from "./strides";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the IR violates a structural invariant the builder relies on. */
export class CubeBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CubeBuilderError";
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /** Override the emitted value form. Defaults to `model.valueForm ?? "auto"`. */
  valueForm?: "auto" | "dense" | "sparse";
  /** Override the sparse threshold (null ratio). Defaults to 0.5. */
  sparseThreshold?: number;
  /** Override status emission. Defaults to `model.statusForm ?? "auto"`. */
  statusForm?: "auto" | "array" | "string" | "object" | "none";
  /** Override dataset metadata. Defaults to `model.meta`. */
  meta?: DatasetMeta;
}

// ---------------------------------------------------------------------------
// Category resolution
// ---------------------------------------------------------------------------

/**
 * Resolved view of a dimension: the ordered category IDs and a map from
 * category ID → its position (0-based). The position is what gets multiplied
 * by the dimension's stride when scattering values.
 */
interface ResolvedDimension {
  id: string;
  column: DimensionColumn;
  categories: string[];
  position: Map<string, number>;
}

function resolveDimension(id: string, column: DimensionColumn): ResolvedDimension {
  let categories: string[];
  if (column.categoryOrder && column.categoryOrder.length > 0) {
    // Honor an explicit order, but verify every observed value is covered.
    const known = new Set(column.categoryOrder);
    for (const v of column.values) {
      if (!known.has(v)) {
        throw new CubeBuilderError(
          `Dimension "${id}": value "${v}" not present in categoryOrder`,
        );
      }
    }
    categories = column.categoryOrder.slice();
  } else {
    // First-seen order, deduplicated.
    const seen = new Set<string>();
    categories = [];
    for (const v of column.values) {
      if (v == null) {
        throw new CubeBuilderError(
          `Dimension "${id}": contains a null category value; dimensions cannot be null`,
        );
      }
      if (!seen.has(v)) {
        seen.add(v);
        categories.push(v);
      }
    }
  }
  const position = new Map<string, number>();
  categories.forEach((c, i) => position.set(c, i));
  return { id, column, categories, position };
}

// ---------------------------------------------------------------------------
// Dimension block
// ---------------------------------------------------------------------------

/** Build the JSON-stat `dimension` object and the `size` array. */
function buildDimensionBlock(
  resolved: ResolvedDimension[],
): { dimension: Record<string, JsonStatDimension>; size: number[] } {
  const dimension: Record<string, JsonStatDimension> = {};
  const size: number[] = [];
  for (const r of resolved) {
    const cat: JsonStatCategory = {};
    // index: array form is the canonical, simplest representation.
    cat.index = r.categories.slice();
    if (r.column.categoryLabels) cat.label = { ...r.column.categoryLabels };
    if (r.column.categoryUnits) cat.unit = { ...r.column.categoryUnits };
    if (r.column.categoryCoordinates)
      cat.coordinates = { ...r.column.categoryCoordinates };
    if (r.column.categoryChild) cat.child = { ...r.column.categoryChild };

    const dim: JsonStatDimension = { category: cat };
    if (r.column.label) dim.label = r.column.label;
    if (r.column.href) dim.href = r.column.href;
    dimension[r.id] = dim;
    size.push(r.categories.length);
  }
  return { dimension, size };
}

// ---------------------------------------------------------------------------
// Value scattering (long table → row-major cube)
// ---------------------------------------------------------------------------

/**
 * Scatter measure values into a dense array of length `total` (null-filled)
 * using row-major positions computed from the resolved dimensions.
 *
 * If two observations map to the same cell, the *last* one wins and a warning
 * is surfaced via the returned diagnostics (the cube model assumes one value
 * per cell; duplicates indicate an ill-formed source).
 */
function scatterValues(
  obs: Observations,
  resolved: ResolvedDimension[],
  size: number[],
): { dense: (number | null)[]; duplicates: number } {
  const total = totalCells(size);
  const dense: (number | null)[] = new Array(total).fill(null);
  const seen = new Uint8Array(total); // 0 = empty, 1 = filled
  let duplicates = 0;
  const n = obs.measure.values.length;
  const k = resolved.length;
  for (let row = 0; row < n; row++) {
    const indices = new Array<number>(k);
    for (let d = 0; d < k; d++) {
      const r = resolved[d];
      const v = r.column.values[row];
      const p = r.position.get(v);
      if (p === undefined) {
        // resolveDimension guarantees coverage when categoryOrder is used, but
        // guard regardless.
        throw new CubeBuilderError(
          `Dimension "${r.id}": value "${v}" has no position (row ${row})`,
        );
      }
      indices[d] = p;
    }
    const pos = flatPosition(indices, size);
    if (seen[pos] === 1) duplicates++;
    seen[pos] = 1;
    dense[pos] = obs.measure.values[row];
  }
  return { dense, duplicates };
}

// ---------------------------------------------------------------------------
// Value form selection (dense vs sparse)
// ---------------------------------------------------------------------------

/**
 * Decide between dense (array) and sparse (object) `value` representation.
 *
 * The object (sparse) `value` form is preferred when many cells are null. The
 * threshold is the null ratio above which the object form is more compact.
 */
function chooseValueForm(
  dense: (number | null)[],
  requested: "auto" | "dense" | "sparse",
  threshold: number,
): { value: JsonStatValue; form: "dense" | "sparse"; nullRatio: number } {
  const total = dense.length;
  const nullCount = dense.reduce<number>((acc, v) => acc + (v === null ? 1 : 0), 0);
  const nullRatio = total === 0 ? 0 : nullCount / total;

  let form: "dense" | "sparse";
  if (requested === "dense") form = "dense";
  else if (requested === "sparse") form = "sparse";
  else form = nullRatio > threshold ? "sparse" : "dense";

  if (form === "dense") {
    return { value: dense, form, nullRatio };
  }
  // Sparse object: only non-null cells, keyed by stringified flat position.
  const obj: Record<string, number> = {};
  for (let i = 0; i < total; i++) {
    const v = dense[i];
    if (v !== null) obj[String(i)] = v;
  }
  return { value: obj, form, nullRatio };
}

// ---------------------------------------------------------------------------
// Status emission
// ---------------------------------------------------------------------------

/**
 * Emit `status` in the most compact correct form.
 *
 * - If all statuses are identical and non-empty → string form.
 * - Else if few distinct non-default statuses → object form (sparse status).
 * - Else → array form (one entry per cell, aligned with dense `value`).
 *
 * The caller passes the *dense* per-cell status array (length = total cells).
 */
function emitStatus(
  perCell: string[],
  requested: "auto" | "array" | "string" | "object" | "none",
): JsonStatStatus | undefined {
  if (requested === "none") return undefined;
  const total = perCell.length;
  if (total === 0) return undefined;

  // Collect distinct statuses and whether they're uniform.
  const first = perCell[0];
  let uniform = true;
  const distinct = new Set<string>();
  for (const s of perCell) {
    distinct.add(s);
    if (s !== first) uniform = false;
  }

  if (requested === "string") return first; // caller's explicit choice
  if (requested === "array") return perCell.slice();

  if (requested === "object") {
    return sparseStatus(perCell);
  }

  // auto:
  if (uniform && first !== "") return first;
  // If most cells share the dominant status, sparse object form is compact.
  const counts = new Map<string, number>();
  for (const s of perCell) counts.set(s, (counts.get(s) ?? 0) + 1);
  let dominant = "";
  let dominantCount = -1;
  for (const [s, c] of counts) {
    if (c > dominantCount) {
      dominant = s;
      dominantCount = c;
    }
  }
  // Use object form when fewer than ~40% of cells deviate from the dominant.
  const nonDominant = total - dominantCount;
  if (dominant !== "" && nonDominant / total < 0.4) {
    return sparseStatus(perCell, dominant);
  }
  return perCell.slice();
}

/** Build the sparse object status form. Omits `defaultStatus` entries. */
function sparseStatus(
  perCell: string[],
  defaultStatus?: string,
): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < perCell.length; i++) {
    const s = perCell[i];
    if (s === "" || s === defaultStatus) continue;
    obj[String(i)] = s;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate the structural invariants the builder relies on. */
function validate(obs: Observations, resolved: ResolvedDimension[]): void {
  const n = obs.measure.values.length;
  for (const r of resolved) {
    if (r.column.values.length !== n) {
      throw new CubeBuilderError(
        `Dimension "${r.id}": ${r.column.values.length} values ≠ ${n} measure values`,
      );
    }
  }
  if (obs.status && obs.status.values.length !== n) {
    throw new CubeBuilderError(
      `Status column: ${obs.status.values.length} values ≠ ${n} measure values`,
    );
  }
  // Every model.dimensionIds entry must have a column, and vice versa.
  const modelIds = new Set(obs.model.dimensionIds);
  const colIds = new Set(Object.keys(obs.dimensions));
  for (const id of modelIds) {
    if (!colIds.has(id)) {
      throw new CubeBuilderError(`model.dimensionIds lists "${id}" but no column exists`);
    }
  }
  for (const id of colIds) {
    if (!modelIds.has(id)) {
      throw new CubeBuilderError(`Column "${id}" is not listed in model.dimensionIds`);
    }
  }
}

// ---------------------------------------------------------------------------
// Build result & public API
// ---------------------------------------------------------------------------

export interface BuildResult {
  dataset: JsonStatDataset;
  /** Diagnostics from the build (non-fatal observations). */
  diagnostics: {
    valueForm: "dense" | "sparse";
    nullRatio: number;
    duplicates: number;
    cellCount: number;
  };
}

/**
 * Build a JSON-stat [`Dataset`](../model/jsonstat.ts) from an
 * [`Observations`](../model/ir.ts) IR.
 *
 * @throws [`CubeBuilderError`](#cubebuildererror) on invariant violations.
 */
export function buildDataset(obs: Observations, options: BuildOptions = {}): BuildResult {
  const model = obs.model;
  const dimensionIds = model.dimensionIds;

  // Resolve dimensions in the model-declared order (this defines stride order).
  const resolved = dimensionIds.map((id) => {
    const col = obs.dimensions[id];
    if (!col) throw new CubeBuilderError(`Missing dimension column "${id}"`);
    return resolveDimension(id, col);
  });

  validate(obs, resolved);

  const { dimension, size } = buildDimensionBlock(resolved);

  // Scatter measure values into the dense row-major array.
  const { dense, duplicates } = scatterValues(obs, resolved, size);

  // Choose value form.
  const valueForm = options.valueForm ?? model.valueForm ?? "auto";
  const threshold = options.sparseThreshold ?? model.sparseThreshold ?? 0.5;
  const { value, form, nullRatio } = chooseValueForm(dense, valueForm, threshold);

  // Status: if present, build a dense per-cell status array aligned with `value`.
  let status: JsonStatStatus | undefined;
  if (obs.status) {
    const statusForm = options.statusForm ?? model.statusForm ?? "auto";
    if (statusForm !== "none") {
      status = buildPerCellStatus(obs, resolved, size, statusForm);
    }
  }

  const dataset: JsonStatDataset = {
    version: "2.0",
    class: "dataset",
    id: dimensionIds.slice(),
    size,
    dimension,
    value,
  };

  // Roles (only attach defined role keys, and only if non-empty).
  const role = filterRoles(model.roles);
  if (role) dataset.role = role;

  // Dataset-level metadata.
  const meta = options.meta ?? model.meta;
  if (meta) {
    if (meta.label) dataset.label = meta.label;
    if (meta.source) dataset.source = meta.source;
    if (meta.updated) dataset.updated = meta.updated;
    if (meta.extension) dataset.extension = meta.extension;
  }

  if (status) dataset.status = status;

  return {
    dataset,
    diagnostics: {
      valueForm: form,
      nullRatio,
      duplicates,
      cellCount: dense.length,
    },
  };
}

/**
 * Build a per-cell status array by scattering the status column into row-major
 * order, then reduce to the requested form. Cells with no observation default
 * to "" (empty), which the emitter treats as "no status".
 */
function buildPerCellStatus(
  obs: Observations,
  resolved: ResolvedDimension[],
  size: number[],
  statusForm: "auto" | "array" | "string" | "object" | "none",
): JsonStatStatus | undefined {
  const total = totalCells(size);
  const perCell: string[] = new Array(total).fill("");
  const n = obs.measure.values.length;
  const k = resolved.length;
  const statusVals = obs.status?.values;
  if (!statusVals) return undefined;
  for (let row = 0; row < n; row++) {
    const indices = new Array<number>(k);
    for (let d = 0; d < k; d++) {
      indices[d] = resolved[d].position.get(resolved[d].column.values[row])!;
    }
    const pos = flatPosition(indices, size);
    perCell[pos] = statusVals[row] ?? "";
  }
  return emitStatus(perCell, statusForm);
}

/** Return a role object with only non-empty arrays, or undefined if all empty. */
function filterRoles(roles?: JsonStatRole): JsonStatRole | undefined {
  if (!roles) return undefined;
  const out: JsonStatRole = {};
  let any = false;
  for (const key of ["time", "geo", "metric"] as const) {
    const arr = roles[key];
    if (arr && arr.length > 0) {
      out[key] = arr.slice();
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Convenience: build and return *just* the dataset (no diagnostics).
 * Useful for the common programmatic case.
 */
export function toDataset(obs: Observations, options?: BuildOptions): JsonStatDataset {
  return buildDataset(obs, options).dataset;
}

// Re-export for consumers who want to enumerate cells themselves.
export { enumerateCells };
