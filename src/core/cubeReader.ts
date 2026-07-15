/**
 * CubeReader — the inverse of [`CubeBuilder`](./cubeBuilder.ts): converts a
 * JSON-stat [`Dataset`](../model/jsonstat.ts) back into the
 * [`Observations`](../model/ir.ts) IR (a tidy long table).
 *
 * ## Why this exists now (Phase-1 import project)
 *
 * Although the primary deliverable is *import* (columnar → JSON-stat), the
 * reader is shipped in v0.1 for two reasons:
 *
 *  1. **Round-trip fidelity tests.** The canonical JSON-stat samples
 *     (oecd, canada, galicia, order, hierarchy, us-gsp, us-unr — from the
 *     official sample suite at https://jsonstat.org/format/) are read into the
 *     IR, written back through the builder, and asserted equal. This is the
 *     strongest correctness proof we have that the importer faithfully
 *     preserves the JSON-stat model.
 *
 *  2. **The Phase-2 export seam.** Export (JSON-stat → columnar) is
 *     `cubeReader` → IR → [`arrowFromCube`](../arrow/arrowFromCube.ts) →
 *     Arrow/Parquet/DuckDB/Polars/CSV writers. Building the reader now means
 *     the IR is verified bidirectional, and Phase 2 is "just" the writers.
 *     See [docs/architecture.md](../../docs/architecture.md) §"The two seams".
 *
 * ## Semantics
 *
 * The reader *materializes the dense cube* from `value` (handling both the
 * array form and the sparse object form), then walks every cell in row-major
 * order ([`multiIndex`](./strides.ts)) to emit one
 * observation per cell. Missing cells (`null`) are emitted as rows with a
 * `null` measure, preserving the full Cartesian product of categories — which
 * is what round-trip equality requires.
 *
 * `status` is normalized back to a per-row `StatusColumn` regardless of whether
 * the source used the string, array, or object form.
 */

import type {
  DimensionColumn,
  MeasureColumn,
  Observations,
  StatusColumn,
} from "../model/ir";
import type {
  JsonStatDataset,
  JsonStatStatus,
  JsonStatValue,
} from "../model/jsonstat";
import { multiIndex, totalCells } from "./strides";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a dataset cannot be read (malformed or unsupported). */
export class CubeReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CubeReaderError";
  }
}

// ---------------------------------------------------------------------------
// Category index resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a dimension's categories into an ordered array + position map,
 * mirroring [`resolveDimension`](./cubeBuilder.ts) but reading from the
 * JSON-stat `category.index` (array or object form).
 */
function resolveCategories(
  dataset: JsonStatDataset,
  dimId: string,
): { categories: string[]; position: Map<string, number> } {
  const dim = dataset.dimension[dimId];
  if (!dim) throw new CubeReaderError(`Missing dimension "${dimId}"`);
  const cat = dim.category;
  if (!cat) {
    // A dimension with no category block: treat as a single implicit category.
    return {
      categories: [dimId],
      position: new Map([[dimId, 0]]),
    };
  }
  const idx = cat.index;
  let categories: string[];
  if (Array.isArray(idx)) {
    categories = idx.slice();
  } else if (idx && typeof idx === "object") {
    // Object form: ID → position. Sort by position ascending.
    categories = Object.entries(idx)
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
  } else {
    // No index: if there's a label object, derive categories from its keys;
    // otherwise it's a constant dimension with a single implicit category.
    if (cat.label && Object.keys(cat.label).length > 0) {
      categories = Object.keys(cat.label);
    } else {
      categories = [dimId];
    }
  }
  const position = new Map<string, number>();
  categories.forEach((c, i) => position.set(c, i));
  return { categories, position };
}

// ---------------------------------------------------------------------------
// Value materialization (dense cube from dense or sparse `value`)
// ---------------------------------------------------------------------------

/**
 * Materialize the full dense value array (length = product of `size`),
 * regardless of whether `value` is the dense array form or the sparse object
 * form. Missing cells become `null`.
 */
function materializeValues(dataset: JsonStatDataset): (number | null)[] {
  const total = totalCells(dataset.size);
  const value = dataset.value as JsonStatValue;
  if (Array.isArray(value)) {
    if (value.length !== total) {
      throw new CubeReaderError(
        `value array length ${value.length} ≠ product(size) ${total}`,
      );
    }
    return value.slice();
  }
  // Sparse object form: keys are stringified flat positions.
  const dense: (number | null)[] = new Array(total).fill(null);
  for (const [k, v] of Object.entries(value)) {
    const pos = Number(k);
    if (!Number.isInteger(pos) || pos < 0 || pos >= total) {
      throw new CubeReaderError(`Sparse value key "${k}" is out of range`);
    }
    dense[pos] = v;
  }
  return dense;
}

// ---------------------------------------------------------------------------
// Status normalization
// ---------------------------------------------------------------------------

/**
 * Normalize any `status` form (string / array / object) into a per-cell array
 * of length `total`. Empty string means "no status for this cell".
 */
function normalizeStatus(
  status: JsonStatStatus | undefined,
  total: number,
): string[] | undefined {
  if (status === undefined) return undefined;
  if (typeof status === "string") {
    return new Array(total).fill(status);
  }
  if (Array.isArray(status)) {
    if (status.length !== total) {
      throw new CubeReaderError(
        `status array length ${status.length} ≠ product(size) ${total}`,
      );
    }
    return status.slice();
  }
  // Object form: position → status. Default "" for cells without an entry.
  const out = new Array<string>(total).fill("");
  for (const [k, v] of Object.entries(status)) {
    const pos = Number(k);
    if (!Number.isInteger(pos) || pos < 0 || pos >= total) {
      throw new CubeReaderError(`Sparse status key "${k}" is out of range`);
    }
    out[pos] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

export interface ReadOptions {
  /**
   * When true (default), cells whose measure is `null` are *omitted* from the
   * emitted long table (a truly sparse/tidy representation). When false, every
   * cell — including nulls — is emitted as a row (required for exact round-trip
   * equality against a dense `value` array).
   */
  dropNulls?: boolean;
}

/**
 * Read a JSON-stat [`Dataset`](../model/jsonstat.ts) into the
 * [`Observations`](../model/ir.ts) IR.
 *
 * @throws [`CubeReaderError`](#cubereadererror) on structural problems.
 */
export function readDataset(
  dataset: JsonStatDataset,
  options: ReadOptions = {},
): Observations {
  if (dataset.class !== "dataset") {
    throw new CubeReaderError(`Expected class "dataset", got "${dataset.class}"`);
  }
  const dropNulls = options.dropNulls ?? true;

  const dimIds = dataset.id;
  const resolvedDims = dimIds.map((id) => ({
    id,
    ...resolveCategories(dataset, id),
  }));

  const total = totalCells(dataset.size);
  const denseValues = materializeValues(dataset);
  const denseStatus = normalizeStatus(dataset.status, total);

  // Walk every cell in row-major order, emitting one observation per cell.
  const dimValues: string[][] = dimIds.map(() => []);
  const measureValues: (number | null)[] = [];
  const statusValues: string[] = [];

  for (let pos = 0; pos < total; pos++) {
    const v = denseValues[pos];
    if (dropNulls && v === null) continue;
    const idx = multiIndex(pos, dataset.size);
    for (let d = 0; d < dimIds.length; d++) {
      dimValues[d].push(resolvedDims[d].categories[idx[d]]);
    }
    measureValues.push(v);
    if (denseStatus) statusValues.push(denseStatus[pos]);
  }

  // Build dimension columns from the resolved metadata + the per-row values.
  const dimensions: Record<string, DimensionColumn> = {};
  for (let d = 0; d < dimIds.length; d++) {
    const id = dimIds[d];
    const dim = dataset.dimension[id];
    const cat = dim?.category;
    dimensions[id] = {
      id,
      values: dimValues[d],
      categoryOrder: resolvedDims[d].categories.slice(),
      categoryLabels: cat?.label ? { ...cat.label } : undefined,
      categoryUnits: cat?.unit ? { ...cat.unit } : undefined,
      categoryCoordinates: cat?.coordinates ? { ...cat.coordinates } : undefined,
      categoryChild: cat?.child ? { ...cat.child } : undefined,
      label: dim?.label,
      href: dim?.href,
    };
  }

  const measure: MeasureColumn = { values: measureValues };

  let status: StatusColumn | undefined;
  if (denseStatus) {
    status = { values: statusValues };
  }

  // Reconstruct the cube model so the result can be fed straight back to the
  // builder and round-trip.
  const obs: Observations = {
    dimensions,
    measure,
    status,
    model: {
      dimensionIds: dimIds.slice(),
      roles: dataset.role ? { ...dataset.role } : undefined,
      meta: {
        label: dataset.label,
        source: dataset.source,
        updated: dataset.updated,
        href: dataset.href,
        extension: dataset.extension ? { ...dataset.extension } : undefined,
      },
      // Preserve the original value form so a round-trip is byte-stable when
      // the builder is run with defaults.
      valueForm: Array.isArray(dataset.value) ? "dense" : "sparse",
      statusForm: dataset.status
        ? typeof dataset.status === "string"
          ? "string"
          : Array.isArray(dataset.status)
            ? "array"
            : "object"
        : "none",
    },
  };

  return obs;
}

/** Convenience: read a JSON-stat response, rejecting non-dataset classes. */
export function readResponse(
  response: unknown,
  options?: ReadOptions,
): Observations {
  const ds = response as JsonStatDataset;
  if (!ds || ds.version !== "2.0" || ds.class !== "dataset") {
    throw new CubeReaderError(
      "Input is not a JSON-stat 2.0 dataset response (missing version/class)",
    );
  }
  return readDataset(ds, options);
}
