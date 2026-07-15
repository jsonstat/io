/**
 * arrowFromCube — the inverse of [`arrowToCube`](./arrowToCube.ts): converts the
 * [`Observations`](../model/ir.ts) IR into an Apache Arrow [`Table`].
 *
 * ## Role
 *
 * This is the **Phase-2 export seam**: the forward path from JSON-stat to the
 * columnar lakehouse stack. Export = [`readDataset`](../core/cubeReader.ts)
 * (JSON-stat → IR) → `cubeToArrow` (IR → Arrow) → Arrow-to-Parquet/DuckDB/
 * Polars/CSV writers (which Arrow ecosystems provide natively).
 *
 * It is shipped in v0.1 (alongside [`cubeReader`](../core/cubeReader.ts)) for
 * two reasons: (1) the round-trip tests use it to assert that JSON-stat → IR →
 * Arrow → IR → JSON-stat is stable; (2) proving the IR is bidirectional now
 * de-risks Phase 2 to "just write the sink writers".
 *
 * ## Mapping
 *
 * - Each dimension → a dictionary-encoded Utf8 column (dictionary = the
 *   resolved category list), annotated with `jsonstat.*` field metadata so the
 *   round-trip preserves labels/units/roles/hierarchies.
 * - The measure → a Float64 column (nulls preserved), marked
 *   `jsonstat.measure=true`.
 * - The status column (if any) → a Utf8 column marked `jsonstat.status=true`.
 * - Dataset-level metadata (label/source/updated/extension/roles/valueForm) is
 *   written to the schema metadata.
 */

import {
  Dictionary,
  Field,
  Float64,
  Int32,
  Schema,
  Table,
  Utf8,
  type Vector,
  makeVector,
  vectorFromArray,
} from "apache-arrow";
import type { DimensionColumn, Observations } from "../model/ir";
import type { Coordinates, JsonStatUnit } from "../model/jsonstat";
import { buildFieldMeta, buildSchemaMeta } from "./schemaMeta";

// ---------------------------------------------------------------------------
// Dimension column construction
// ---------------------------------------------------------------------------

/**
 * Build a dictionary-encoded Utf8 Arrow vector for a dimension column, plus the
 * `jsonstat.*` field metadata that preserves labels/units/roles/hierarchies.
 *
 * We use a dictionary with Utf8 values — the most natural Arrow representation
 * of a categorical dimension, and what [`arrowToCube`](./arrowToCube.ts) reads
 * back losslessly.
 */
function buildDimensionColumn(col: DimensionColumn): {
  name: string;
  vector: Vector;
  field: Field;
} {
  // Enumerate the canonical category order: explicit if given, else
  // first-seen. This is attached to the field metadata so arrowToCube can
  // restore the exact order on the round-trip.
  const order = resolveCategoryOrder(col);

  // Build the dictionary vector from the raw string values. arrowToCube reads
  // the dictionary values for category IDs and the metadata for ordering.
  const vector = vectorFromArray(col.values, new Dictionary(new Utf8(), new Int32()));

  // Field metadata preserving the JSON-stat dimension model.
  const metadata = buildFieldMeta({
    label: col.label,
    categoryLabels: col.categoryLabels,
    categoryUnits: col.categoryUnits as Record<string, JsonStatUnit> | undefined,
    categoryCoords: col.categoryCoordinates as Record<string, Coordinates> | undefined,
    categoryChild: col.categoryChild,
    categoryOrder: col.categoryOrder ?? (order.length > 0 ? order : undefined),
  });

  const field = new Field(col.id, new Dictionary(new Utf8(), new Int32()), true, metadata);

  return { name: col.id, vector, field };
}

/**
 * Resolve the canonical category order for a dimension: explicit order if
 * given, otherwise first-seen from the values.
 */
function resolveCategoryOrder(col: DimensionColumn): string[] {
  if (col.categoryOrder && col.categoryOrder.length > 0) {
    return col.categoryOrder.slice();
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of col.values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert the [`Observations`](../model/ir.ts) IR into an Arrow [`Table`].
 *
 * Each dimension becomes a dictionary column; the measure becomes a Float64
 * column; the optional status becomes a Utf8 column. All `jsonstat.*`
 * metadata is attached so the result round-trips through [`arrowToCube`](./arrowToCube.ts).
 *
 * @throws Error if a dimension column referenced by the model is missing.
 */
export function cubeToArrow(obs: Observations): Table {
  const n = obs.measure.values.length;
  const dimIds = obs.model.dimensionIds;

  const fields: Field[] = [];
  const columns: Record<string, Vector> = {};

  // --- Dimension columns -------------------------------------------------
  for (const id of dimIds) {
    const col = obs.dimensions[id];
    if (!col) {
      throw new Error(`arrowFromCube: missing dimension column "${id}"`);
    }
    const built = buildDimensionColumn(col);

    // Attach the role (if any) to the field metadata.
    const role = roleFor(obs, id);
    if (role) {
      built.field.metadata.set("jsonstat.role", role);
    }

    fields.push(built.field);
    columns[built.name] = built.vector;
  }

  // --- Measure column (Float64, nulls preserved) -------------------------
  const measureValues = new Float64Array(n);
  let nullCount = 0;
  for (let i = 0; i < n; i++) {
    const v = obs.measure.values[i];
    if (v === null) {
      nullCount++;
    } else {
      measureValues[i] = v;
    }
  }
  const measureVector = makeVector(measureValues);
  const measureName = obs.measure.name ?? "value";
  const measureMeta = buildFieldMeta({ measure: true });
  const measureField = new Field(measureName, new Float64(), true, measureMeta);
  fields.push(measureField);
  columns[measureName] = measureVector;
  // Track nulls for the measure so arrowToCube reads them back as null.
  if (nullCount > 0) {
    // makeVector(Float64Array) has nullCount 0; we need to rebuild with a
    // validity bitmap so the nulls survive the round-trip. Reconstruct using
    // a Uint8Array value selector.
    columns[measureName] = buildNullableFloat64Vector(obs.measure.values);
  }

  // --- Status column (Utf8), if present ---------------------------------
  if (obs.status) {
    const statusName = "status";
    const statusVector = vectorFromArray(
      obs.status.values.map((s) => (s === "" ? null : s)),
      new Utf8(),
    );
    const statusMeta = buildFieldMeta({ status: true });
    const statusField = new Field(statusName, new Utf8(), true, statusMeta);
    fields.push(statusField);
    columns[statusName] = statusVector;
  }

  // --- Schema with dataset-level metadata --------------------------------
  const schemaMeta = buildSchemaMeta({
    label: obs.model.meta?.label,
    source: obs.model.meta?.source,
    updated: obs.model.meta?.updated,
    extension: obs.model.meta?.extension as Record<string, unknown> | undefined,
    roles: obs.model.roles,
    valueForm: obs.model.valueForm,
  });

  const schema = new Schema(fields, schemaMeta);

  return new Table(schema, columns);
}

/**
 * Build a Float64 Vector that preserves nulls via a validity bitmap.
 * `makeVector(Float64Array)` always reports nullCount 0, so when the measure
 * contains nulls we construct the Data manually with a null bitmap.
 */
function buildNullableFloat64Vector(values: (number | null)[]): Vector {
  const n = values.length;
  const data = new Float64Array(n);
  const nullCount = values.filter((v) => v === null).length;
  // Arrow validity bitmap: 1 bit per row, little-endian within each byte.
  // A set bit (1) means the value is valid (non-null).
  const numBytes = Math.ceil(n / 8);
  const nullBitmap = new Uint8Array(numBytes);
  for (let i = 0; i < n; i++) {
    if (values[i] !== null) {
      data[i] = values[i] as number;
      nullBitmap[Math.floor(i / 8)] |= 1 << (i % 8);
    }
  }
  // makeVector's options union is intentionally broad across Arrow versions; the
  // object above is a valid Float64 init, so we widen via a typed shim.
  const vector = makeVector({
    type: new Float64(),
    data,
    nullBitmap,
    length: n,
    nullCount,
  } as Parameters<typeof makeVector>[0]);
  return vector;
}

/** Look up the role (if any) assigned to a dimension id in the model. */
function roleFor(obs: Observations, id: string): "time" | "geo" | "metric" | undefined {
  const roles = obs.model.roles;
  if (!roles) return undefined;
  if (roles.time?.includes(id)) return "time";
  if (roles.geo?.includes(id)) return "geo";
  if (roles.metric?.includes(id)) return "metric";
  return undefined;
}
