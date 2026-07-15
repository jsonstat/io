/**
 * arrowToCube — the Arrow hub converter.
 *
 * Converts an Apache Arrow [`Table`](https://arrow.apache.org/docs/js/) into the
 * [`Observations`](../model/ir.ts) IR. Because Parquet, DuckDB, and Polars can
 * all emit Arrow tables natively, this single converter serves three sources —
 * the core leverage point of the architecture (see
 * [docs/architecture.md](../../docs/architecture.md) §"The Arrow-hub insight").
 *
 * ## Mapping rules
 *
 *  1. **Dimensions** = dictionary-encoded columns (or string columns). Their
 *     dictionary values become JSON-stat categories. The per-field
 *     `jsonstat.*` metadata (see [`schemaMeta`](./schemaMeta.ts)) supplies
 *     labels, units, coordinates, hierarchies, ordering, and roles.
 *  2. **Measure** = the first non-dictionary numeric column, *or* the column
 *     marked `jsonstat.measure=true`. If a `--measure` hint is supplied it
 *     overrides detection.
 *  3. **Status** = the column marked `jsonstat.status=true`, if any.
 *
 * When metadata is absent, the converter infers conservatively and the result
 * is still a valid (if minimally-annotated) JSON-stat dataset.
 */

import {
  Bool,
  type DataType,
  DateDay,
  DateMillisecond,
  Dictionary,
  type Field,
  Float32,
  Float64,
  Int32,
  Int64,
  type Table,
  TimestampMillisecond,
  TimestampSecond,
  Utf8,
  type Vector,
} from "apache-arrow";
import type {
  DimensionColumn,
  MeasureColumn,
  Observations,
  RoleMap,
  StatusColumn,
} from "../model/ir";
import type { Coordinates, JsonStatUnit } from "../model/jsonstat";
import {
  getFieldMetaJson,
  getFieldRole,
  isMeasureField,
  isStatusField,
  readSchemaMeta,
} from "./schemaMeta";

// ---------------------------------------------------------------------------
// Errors & options
// ---------------------------------------------------------------------------

export class ArrowConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArrowConversionError";
  }
}

export interface ArrowToCubeOptions {
  /** Explicit measure column name. Overrides detection + metadata. */
  measure?: string;
  /** Explicit dimension column names, in order. Overrides detection. */
  dimensions?: string[];
  /** Explicit status column name. Overrides metadata. */
  status?: string;
  /** Explicit role assignments (merge with, and take precedence over, metadata). */
  roles?: RoleMap;
  /** Value-form hint forwarded to the cube model. */
  valueForm?: "auto" | "dense" | "sparse";
}

// ---------------------------------------------------------------------------
// Type predicates
// ---------------------------------------------------------------------------

/** Is this Arrow data type a dictionary (the natural dimension representation)? */
function isDictionaryType(t: DataType): t is Dictionary<DataType, Int32> {
  return t instanceof Dictionary;
}

/** Is this Arrow data type numeric (suitable for a measure)? */
function isNumericType(t: DataType): boolean {
  return t instanceof Int32 || t instanceof Int64 || t instanceof Float32 || t instanceof Float64;
}

/** Is this Arrow data type a string/utf8 (a fallback dimension type)? */
function isStringType(t: DataType): boolean {
  return t instanceof Utf8;
}

/** Is this Arrow data type a temporal type (a time-dimension candidate)? */
function isTemporalType(t: DataType): boolean {
  return (
    t instanceof DateDay ||
    t instanceof DateMillisecond ||
    t instanceof TimestampSecond ||
    t instanceof TimestampMillisecond
  );
}

/** Is this column a dimension candidate (dictionary, string, temporal, or bool)? */
function isDimensionCandidate(t: DataType): boolean {
  return isDictionaryType(t) || isStringType(t) || isTemporalType(t) || t instanceof Bool;
}

// ---------------------------------------------------------------------------
// Column extraction
// ---------------------------------------------------------------------------

/**
 * Extract a dimension column from an Arrow vector. Reads the dictionary values
 * (for dictionary-encoded columns) or the raw string values (for utf8), plus
 * any `jsonstat.*` metadata.
 */
function extractDimension(
  name: string,
  vec: Vector,
  field: Field,
  rowCount: number,
): DimensionColumn {
  const values: string[] = new Array(rowCount);

  // Dictionary-encoded: Vector.get(i) returns the decoded dictionary value
  // in Arrow v17, so we can treat dictionary columns the same as strings.
  if (isDictionaryType(vec.type)) {
    for (let i = 0; i < rowCount; i++) {
      const v = vec.get(i);
      if (v === null) {
        throw new ArrowConversionError(
          `Dimension "${name}": null value at row ${i}; dimensions cannot be null`,
        );
      }
      values[i] = String(v);
    }
  } else if (isStringType(vec.type)) {
    for (let i = 0; i < rowCount; i++) {
      const v = vec.get(i);
      if (v === null) {
        throw new ArrowConversionError(
          `Dimension "${name}": null value at row ${i}; dimensions cannot be null`,
        );
      }
      values[i] = String(v);
    }
  } else if (isTemporalType(vec.type)) {
    // Normalize temporal values to ISO strings for stable category IDs.
    for (let i = 0; i < rowCount; i++) {
      const v = vec.get(i);
      if (v === null) {
        throw new ArrowConversionError(
          `Dimension "${name}": null value at row ${i}; dimensions cannot be null`,
        );
      }
      // DateDay/DateMillisecond return JS Date or epoch; normalize.
      const d = v instanceof Date ? v : new Date(v);
      values[i] = d.toISOString().slice(0, 10); // YYYY-MM-DD
    }
  } else if (vec.type instanceof Bool) {
    for (let i = 0; i < rowCount; i++) {
      const v = vec.get(i);
      values[i] = v === null ? "" : v ? "true" : "false";
    }
  } else {
    // Coerce any other type to string.
    for (let i = 0; i < rowCount; i++) {
      const v = vec.get(i);
      values[i] = v === null ? "" : String(v);
    }
  }

  // Pull JSON-stat metadata from the field (passed from the table schema).
  const categoryLabels = getFieldMetaJson<Record<string, string>>(field, "categoryLabels");
  const categoryUnits = getFieldMetaJson<Record<string, JsonStatUnit>>(field, "categoryUnits");
  const categoryCoords = getFieldMetaJson<Record<string, Coordinates>>(field, "categoryCoords");
  const categoryChild = getFieldMetaJson<Record<string, string[]>>(field, "categoryChild");
  const categoryOrder = getFieldMetaJson<string[]>(field, "categoryOrder");
  const label = field.metadata.get("jsonstat.label") ?? undefined;

  return {
    id: name,
    values,
    categoryOrder,
    categoryLabels,
    categoryUnits,
    categoryCoordinates: categoryCoords,
    categoryChild,
    label,
    href: field.metadata.get("jsonstat.href") ?? undefined,
  };
}

/** Extract the measure column as numeric values with nulls. */
function extractMeasure(name: string, vec: Vector, rowCount: number): MeasureColumn {
  const values: (number | null)[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i++) {
    const v = vec.get(i);
    values[i] = v === null ? null : Number(v);
  }
  return { name, values };
}

/** Extract the status column as string values. */
function extractStatus(vec: Vector, rowCount: number): StatusColumn {
  const values: string[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i++) {
    const v = vec.get(i);
    values[i] = v === null ? "" : String(v);
  }
  return { values };
}

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

/**
 * Resolve roles: start from field metadata, overlay schema-level roles, then
 * apply caller-supplied hints (which win). Also infer a `time` role for the
 * first temporal dimension if no role is declared.
 */
function resolveRoles(
  table: Table,
  dimensionNames: string[],
  options: ArrowToCubeOptions,
): RoleMap {
  const roles: RoleMap = {};
  const add = (role: keyof RoleMap, id: string) => {
    roles[role] = [...(roles[role] ?? []), id];
  };

  // 1. Field-level metadata roles.
  for (const name of dimensionNames) {
    const field = table.schema.fields.find((f) => f.name === name);
    if (!field) continue;
    const r = getFieldRole(field);
    if (r) add(r, name);
  }

  // 2. Schema-level roles (merge).
  const schemaRoles = readSchemaMeta(table.schema).roles;
  if (schemaRoles) {
    for (const role of ["time", "geo", "metric"] as const) {
      for (const id of schemaRoles[role] ?? []) {
        if (!(roles[role] ?? []).includes(id)) add(role, id);
      }
    }
  }

  // 3. Inference: if no time role, assign it to the first temporal dimension.
  if (!roles.time || roles.time.length === 0) {
    for (const name of dimensionNames) {
      const field = table.schema.fields.find((f) => f.name === name);
      if (field && isTemporalType(field.type)) {
        add("time", name);
        break;
      }
    }
  }

  // 4. Caller hints win.
  if (options.roles) {
    for (const role of ["time", "geo", "metric"] as const) {
      for (const id of options.roles[role] ?? []) {
        if (!(roles[role] ?? []).includes(id)) add(role, id);
      }
    }
  }

  return roles;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert an Arrow [`Table`] into the [`Observations`] IR.
 *
 * @throws [`ArrowConversionError`](#arrowconversionerror) on mapping problems.
 */
export function arrowToCube(table: Table, options: ArrowToCubeOptions = {}): Observations {
  const rowCount = table.numRows;
  if (rowCount === 0) {
    throw new ArrowConversionError("Arrow table has no rows");
  }

  const fieldNames = table.schema.fields.map((f) => f.name);
  if (fieldNames.length === 0) {
    throw new ArrowConversionError("Arrow table has no columns");
  }

  // --- Measure column -----------------------------------------------------
  // Resolve the measure column name to a definite string: explicit hint >
  // jsonstat.measure marker > first numeric column; throw if none found.
  const measureCol: string =
    options.measure ??
    table.schema.fields.find((f) => isMeasureField(f))?.name ??
    table.schema.fields.find((f) => isNumericType(f.type))?.name ??
    (() => {
      throw new ArrowConversionError(
        "No measure column found: no numeric column and no jsonstat.measure marker. " +
          "Pass options.measure to specify one.",
      );
    })();
  const measureVec = table.getChild(measureCol);
  if (!measureVec) {
    throw new ArrowConversionError(`Measure column "${measureCol}" not found in table`);
  }
  const measure = extractMeasure(measureCol, measureVec, rowCount);

  // --- Status column ------------------------------------------------------
  let status: StatusColumn | undefined;
  let statusName = options.status;
  if (!statusName) {
    const marked = table.schema.fields.find((f) => isStatusField(f));
    if (marked) statusName = marked.name;
  }
  if (statusName) {
    const vec = table.getChild(statusName);
    if (!vec) {
      throw new ArrowConversionError(`Status column "${statusName}" not found`);
    }
    status = extractStatus(vec, rowCount);
  }

  // --- Dimension columns --------------------------------------------------
  let dimensionNames: string[];
  if (options.dimensions) {
    dimensionNames = options.dimensions;
    // Validate they exist.
    for (const name of dimensionNames) {
      if (!fieldNames.includes(name)) {
        throw new ArrowConversionError(`Dimension column "${name}" not found`);
      }
    }
  } else {
    // Every column that is not the measure or status, and is a dimension
    // candidate (dictionary/string/temporal/bool), becomes a dimension.
    dimensionNames = table.schema.fields
      .filter((f) => f.name !== measureCol && f.name !== statusName && isDimensionCandidate(f.type))
      .map((f) => f.name);
    if (dimensionNames.length === 0) {
      throw new ArrowConversionError(
        "No dimension columns found (need dictionary/string/temporal/bool columns " +
          "distinct from the measure). Pass options.dimensions to specify them.",
      );
    }
  }

  const dimensions: Record<string, DimensionColumn> = {};
  for (const name of dimensionNames) {
    const vec = table.getChild(name);
    if (!vec) {
      throw new ArrowConversionError(`Dimension column "${name}" not found`);
    }
    const field = table.schema.fields.find((f) => f.name === name);
    if (!field) {
      throw new ArrowConversionError(`Dimension field "${name}" not found in schema`);
    }
    dimensions[name] = extractDimension(name, vec, field, rowCount);
  }

  // --- Roles & model ------------------------------------------------------
  const roles = resolveRoles(table, dimensionNames, options);
  const schemaMeta = readSchemaMeta(table.schema);

  const observations: Observations = {
    dimensions,
    measure,
    status,
    model: {
      dimensionIds: dimensionNames.slice(),
      roles,
      meta: schemaMeta.meta,
      valueForm: options.valueForm ?? schemaMeta.valueForm ?? "auto",
      statusForm: status ? "auto" : "none",
    },
  };

  return observations;
}

/** Convenience: convert an Arrow table straight to a JSON-stat dataset. */
export async function arrowToDataset(
  table: Table,
  options?: ArrowToCubeOptions,
): Promise<import("../model/jsonstat").JsonStatDataset> {
  // Lazy import to avoid a hard build-time dependency cycle for tree-shaking.
  const { toDataset } = await import("../core/cubeBuilder");
  return toDataset(arrowToCube(table, options));
}
