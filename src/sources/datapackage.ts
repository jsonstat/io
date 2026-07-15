/**
 * Data Package (Frictionless) adapter — bidirectional bridge between a
 * Frictionless Data Package and the [`Observations`](../model/ir.ts) IR.
 *
 * A Data Package is a JSON descriptor (`datapackage.json`) that lists one or
 * more *resources*, each pointing at a data file (typically CSV) and declaring
 * a `schema` with typed `fields` and a `primaryKey`. This is conceptually
 * parallel to [CSVW](./csvw.ts): both attach a typed schema to a CSV file. The
 * two differ in vocabulary — Data Package uses lowercase JSON Table Schema
 * field `type`s (`integer`, `number`, `string`, …) and the `primaryKey` lives
 * on the schema, while CSVW uses `datatype` + `propertyUrl` + `tableSchema`.
 *
 * The adapter handles the **single-resource** case (the common one for
 * statistical datasets): the first resource whose data is CSV-shaped is read.
 * `options.resourcePath` or `options.resourceIndex` selects a non-first
 * resource. Multi-resource packages are out of scope — split them first.
 *
 * See https://datapackage.org/ for the standard.
 *
 * @module
 */

import type { JsonStatDataset } from "../model/jsonstat";
import type {
  DimensionColumn,
  MeasureColumn,
  Observations,
  RoleMap,
  StatusColumn,
} from "../model/ir";
import { parseCsv, cubeColumns, serializeRows } from "./csv";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Thrown on structural problems reading or writing a Data Package. */
export class DataPackageSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataPackageSourceError";
  }
}

// ---------------------------------------------------------------------------
// Metadata types (only the fields we use)
// ---------------------------------------------------------------------------

/**
 * A field declaration in a Data Package Table Schema.
 *
 * Mirrors the JSON Table Schema spec; `name` and `type` are the only fields
 * the adapter relies on. `constraints` and `rdfType` are parsed for role hints.
 */
export interface DataPackageField {
  /** Field name (becomes the column header / dimension id). */
  name: string;
  /**
   * JSON Table Schema type: `string`, `integer`, `number`, `boolean`, `date`,
   * `time`, `datetime`, `year`, `yearmonth`, `object`, `array`, `duration`,
   * `geopoint`, `geojson`, `any`. Numeric types resolve the measure.
   */
  type?: string;
  /** Human-readable title. Falls back to `name`. */
  title?: string;
  /** Free-text description (not emitted by the builder, kept for round-trip). */
  description?: string;
  /** RDF type URL; parsed for role hints like CSVW `propertyUrl`. */
  rdfType?: string;
  /** Field constraints (parsed but only `required` is honored). */
  constraints?: { required?: boolean; [k: string]: unknown };
}

/** The `schema` object on a Data Package resource. */
export interface DataPackageSchema {
  fields: DataPackageField[];
  /** Column name(s) uniquely identifying a row. Becomes dimensions by default. */
  primaryKey?: string | string[];
  /** Foreign keys are parsed but not enforced. */
  foreignKeys?: unknown[];
  /** A missing-value marker for the data (treated as null). */
  missingValues?: string[];
}

/** A resource within a Data Package. */
export interface DataPackageResource {
  /** Resource name (a slug). */
  name?: string;
  /** Relative path to the data file this resource describes. */
  path?: string;
  /** Inline data (array of objects); supported as an alternative to `path`. */
  data?: Record<string, unknown>[];
  /** CSV dialect; only `delimiter` is honored. */
  dialect?: { delimiter?: string; header?: boolean };
  /** The Table Schema for this resource. */
  schema?: DataPackageSchema;
}

/**
 * A trimmed Data Package descriptor (only the fields we use).
 *
 * Dataset-level metadata (`title`, `homepage`, etc.) maps to JSON-stat
 * dataset properties; the `jsonstat:*` keys are a vendor extension for
 * lossless round-trip of roles / value-form / extension.
 */
export interface DataPackageMetadata {
  name?: string;
  title?: string;
  description?: string;
  homepage?: string;
  version?: string;
  licenses?: { name?: string; path?: string; title?: string }[];
  sources?: { title?: string; path?: string; email?: string }[];
  /** ISO 8601; mapped to the dataset `updated`. */
  created?: string;
  resources: DataPackageResource[];
  /**
   * Vendor extension: roles to assign to dimensions. Round-trips the
   * `role` object from the IR model.
   */
  "jsonstat:roles"?: RoleMap;
  /** Vendor extension: dataset `extension` object. */
  "jsonstat:extension"?: Record<string, unknown>;
  /** Vendor extension: how to emit `value`. */
  "jsonstat:valueForm"?: "auto" | "dense" | "sparse";
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DataPackageToCubeOptions {
  /** Explicit measure field name. Overrides schema-based detection. */
  measure?: string;
  /** Explicit dimension field names, in order. */
  dimensions?: string[];
  /** Explicit status field name. */
  status?: string;
  /** Role assignments (merged with, and overriding, metadata hints). */
  roles?: RoleMap;
  /**
   * Select a resource by `path` when the package has more than one. Defaults
   * to the first resource.
   */
  resourcePath?: string;
  /** Select a resource by zero-based index (default 0). */
  resourceIndex?: number;
  /** CSV delimiter override (default: from the resource dialect, or ","). */
  delimiter?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Is a JSON Table Schema field type numeric? */
function isNumericType(type: string | undefined): boolean {
  if (!type) return false;
  return type === "integer" || type === "number";
}

/**
 * Infer a role from a field's `rdfType` (analogous to CSVW `propertyUrl`).
 * Recognizes schema.org / time / geo / measure vocabulary.
 */
function roleFromRdfType(rdfType: string | undefined): "time" | "geo" | "metric" | undefined {
  if (!rdfType) return undefined;
  const u = rdfType.toLowerCase();
  if (u.includes("time") || u.includes("date") || u.includes("temporal")) return "time";
  if (u.includes("geo") || u.includes("spatial") || u.includes("place")) return "geo";
  if (u.includes("metric") || u.includes("measure") || u.includes("observation")) return "metric";
  return undefined;
}

/** Pick a field's title, falling back to its name. */
function fieldTitle(f: DataPackageField): string {
  return f.title ?? f.name;
}

/**
 * Select the resource to read from a package.
 *
 * Exported so the high-level dispatcher (see [`index.ts`](../index.ts)) can
 * resolve which resource's CSV to load before calling [`datapackageToCube`].
 *
 * @throws [`DataPackageSourceError`] if none matches.
 */
export function selectResource(
  metadata: DataPackageMetadata,
  options: DataPackageToCubeOptions,
): DataPackageResource {
  if (!metadata.resources?.length) {
    throw new DataPackageSourceError("Data Package has no resources");
  }
  if (options.resourcePath) {
    const r = metadata.resources.find((res) => res.path === options.resourcePath);
    if (!r) {
      throw new DataPackageSourceError(
        `No resource with path "${options.resourcePath}" in the package`,
      );
    }
    return r;
  }
  const idx = options.resourceIndex ?? 0;
  const r = metadata.resources[idx];
  if (!r) {
    throw new DataPackageSourceError(`No resource at index ${idx}`);
  }
  return r;
}

/** Convert an inline `data` array (objects) into the columnar form parseCsv yields. */
function inlineToColumns(
  data: Record<string, unknown>[],
  fields: DataPackageField[],
): { header: string[]; columns: string[][] } {
  const header = fields.map((f) => f.name);
  const columns: string[][] = fields.map(() => []);
  for (const row of data) {
    for (let c = 0; c < fields.length; c++) {
      const v = row[fields[c].name];
      columns[c].push(v === null || v === undefined ? "" : String(v));
    }
  }
  return { header, columns };
}

// ---------------------------------------------------------------------------
// Import: CSV (+ Data Package) → Observations IR
// ---------------------------------------------------------------------------

/**
 * Convert CSV text + a Data Package descriptor into the [`Observations`] IR.
 *
 * The first resource (or the one selected by `options.resourcePath` /
 * `options.resourceIndex`) is read. If the resource declares inline `data`,
 * that is used instead of `csvText`.
 *
 * @param csvText The raw CSV content for the selected resource. May be empty
 *        when the resource carries inline `data`.
 * @param metadata The parsed Data Package descriptor.
 * @throws [`DataPackageSourceError`] on structural problems.
 */
export function datapackageToCube(
  csvText: string,
  metadata: DataPackageMetadata,
  options: DataPackageToCubeOptions = {},
): Observations {
  const resource = selectResource(metadata, options);
  if (!resource.schema?.fields?.length) {
    throw new DataPackageSourceError(
      "Selected resource is missing schema.fields",
    );
  }
  const fields = resource.schema.fields;
  const missingValues = new Set(resource.schema.missingValues ?? [""]);

  // --- Read columns (from inline data or parsed CSV) ---------------------
  let columnValues: string[][];
  if (resource.data && resource.data.length > 0) {
    columnValues = inlineToColumns(resource.data, fields).columns;
  } else {
    const delimiter = options.delimiter ?? resource.dialect?.delimiter ?? ",";
    const header = resource.dialect?.header ?? true;
    const rows = parseCsv(csvText, delimiter);
    if (rows.length === 0) throw new DataPackageSourceError("CSV has no rows");
    const dataRows = header ? rows.slice(1) : rows;
    if (dataRows.length === 0) {
      throw new DataPackageSourceError("CSV has no data rows");
    }
    // Read by position, label by schema field name.
    columnValues = fields.map(() => []);
    for (const r of dataRows) {
      for (let c = 0; c < fields.length; c++) {
        columnValues[c].push(r[c] ?? "");
      }
    }
  }

  // --- Resolve measure (default-measure rule) ----------------------------
  // Precedence: explicit option.measure > a field named "value"
  // (case-insensitive) > first numeric-type field.
  let measureIdx = fields.findIndex((f) => f.name === options.measure);
  if (measureIdx === -1 && !options.measure) {
    measureIdx = fields.findIndex((f) => f.name.toLowerCase() === "value");
  }
  if (measureIdx === -1) {
    measureIdx = fields.findIndex((f) => isNumericType(f.type));
    if (measureIdx === -1) {
      throw new DataPackageSourceError(
        "No measure field: no field is named 'value' or has a numeric type " +
          "(integer/number). Pass options.measure to name one.",
      );
    }
  }

  // --- Resolve status ----------------------------------------------------
  let statusIdx = fields.findIndex((f) => f.name === options.status);
  if (statusIdx === -1 && !options.status) {
    statusIdx = fields.findIndex((f) => f.name.toLowerCase() === "status");
    if (statusIdx === measureIdx) statusIdx = -1;
  }

  // --- Resolve dimensions ------------------------------------------------
  let dimensionIdxs: number[];
  if (options.dimensions) {
    dimensionIdxs = options.dimensions.map((n) => {
      const idx = fields.findIndex((f) => f.name === n);
      if (idx === -1) {
        throw new DataPackageSourceError(`Dimension field "${n}" not in schema`);
      }
      return idx;
    });
  } else {
    // Prefer primaryKey fields as dimensions, in declared order; append any
    // remaining non-measure/non-status fields.
    const pk = resource.schema.primaryKey
      ? Array.isArray(resource.schema.primaryKey)
        ? resource.schema.primaryKey
        : [resource.schema.primaryKey]
      : [];
    if (pk.length > 0) {
      dimensionIdxs = pk.map((n) => {
        const idx = fields.findIndex((f) => f.name === n);
        if (idx === -1) {
          throw new DataPackageSourceError(`primaryKey field "${n}" not in schema`);
        }
        return idx;
      });
      for (let i = 0; i < fields.length; i++) {
        if (i === measureIdx || i === statusIdx || dimensionIdxs.includes(i)) continue;
        dimensionIdxs.push(i);
      }
    } else {
      dimensionIdxs = fields
        .map((_, i) => i)
        .filter((i) => i !== measureIdx && i !== statusIdx);
    }
  }
  if (dimensionIdxs.length === 0) {
    throw new DataPackageSourceError("No dimension fields resolved");
  }

  // --- Build dimension columns -------------------------------------------
  const dimensions: Record<string, DimensionColumn> = {};
  for (const idx of dimensionIdxs) {
    const f = fields[idx];
    dimensions[f.name] = {
      id: f.name,
      values: columnValues[idx].map((v) =>
        missingValues.has(v) ? "" : v,
      ),
      label: fieldTitle(f),
    };
  }

  // --- Measure: parse numerically ----------------------------------------
  const measure: MeasureColumn = {
    name: fields[measureIdx].name,
    values: columnValues[measureIdx].map((v) => {
      if (missingValues.has(v)) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }),
  };

  let status: StatusColumn | undefined;
  if (statusIdx !== -1) {
    status = { values: columnValues[statusIdx].slice() };
  }

  // --- Roles: metadata hints + rdfType inference + caller overrides ------
  const roles: RoleMap = {};
  const addRole = (role: keyof RoleMap, id: string) => {
    (roles[role] ??= []).push(id);
  };
  if (metadata["jsonstat:roles"]) {
    for (const r of ["time", "geo", "metric"] as const) {
      for (const id of metadata["jsonstat:roles"][r] ?? []) addRole(r, id);
    }
  }
  for (const idx of dimensionIdxs) {
    const role = roleFromRdfType(fields[idx].rdfType);
    if (role) addRole(role, fields[idx].name);
  }
  if (options.roles) {
    for (const r of ["time", "geo", "metric"] as const) {
      for (const id of options.roles[r] ?? []) addRole(r, id);
    }
  }

  // --- Dataset-level metadata --------------------------------------------
  const source = metadata.sources?.[0]?.title ?? metadata.homepage;

  const observations: Observations = {
    dimensions,
    measure,
    status,
    model: {
      dimensionIds: dimensionIdxs.map((i) => fields[i].name),
      roles: Object.keys(roles).length ? roles : undefined,
      meta: {
        label: metadata.title ?? metadata.name,
        source,
        updated: metadata.created,
        extension: metadata["jsonstat:extension"],
      },
      valueForm: metadata["jsonstat:valueForm"] ?? "auto",
      statusForm: status ? "auto" : "none",
    },
  };

  return observations;
}

/** Convenience: Data Package (CSV + metadata) → JSON-stat [`Dataset`]. */
export async function datapackageToDataset(
  csvText: string,
  metadata: DataPackageMetadata,
  options?: DataPackageToCubeOptions,
): Promise<JsonStatDataset> {
  const { toDataset } = await import("../core/cubeBuilder");
  return toDataset(datapackageToCube(csvText, metadata, options));
}

/** Parse a Data Package JSON descriptor, validating minimally. */
export function parseDataPackageMetadata(json: unknown): DataPackageMetadata {
  const m = json as DataPackageMetadata;
  if (!m || !Array.isArray(m.resources)) {
    throw new DataPackageSourceError(
      "Invalid Data Package: missing resources[]",
    );
  }
  return m;
}

// ---------------------------------------------------------------------------
// Export: Observations IR → Data Package (CSV + datapackage.json)
// ---------------------------------------------------------------------------

export interface CubeToDataPackageOptions {
  /** CSV delimiter (default ","). */
  delimiter?: string;
  /** Line terminator: "\r\n" (default) or "\n". */
  lineTerminator?: string;
  /** The `path` of the CSV file the resource describes (default "data.csv"). */
  path?: string;
  /** The package `name` slug (defaults to a slug of the dataset label). */
  name?: string;
}

/** Result of [`cubeToDataPackage`]: the CSV body + the descriptor. */
export interface DataPackageExport {
  /** The CSV text (header + rows). */
  csv: string;
  /** The Data Package descriptor, ready to `JSON.stringify`. */
  metadata: DataPackageMetadata;
}

/** Look up the role of a dimension id in the IR model. */
function roleOf(
  obs: Observations,
  id: string,
): "time" | "geo" | "metric" | undefined {
  const roles = obs.model.roles;
  if (!roles) return undefined;
  if (roles.time?.includes(id)) return "time";
  if (roles.geo?.includes(id)) return "geo";
  if (roles.metric?.includes(id)) return "metric";
  return undefined;
}

/** Map a JSON-stat role to an rdfType URL hint on a field. */
function rdfTypeForRole(
  role: "time" | "geo" | "metric" | undefined,
): string | undefined {
  if (role === "time") return "https://schema.org/DateTime";
  if (role === "geo") return "https://schema.org/Place";
  if (role === "metric") return "https://schema.org/Measure";
  return undefined;
}

/** Turn a label into a URL-safe slug for the package `name`. */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "dataset";
}

/**
 * Write the [`Observations`](../model/ir.ts) IR to a Data Package pair: the
 * CSV text (RFC-4180) and a Data Package descriptor with a single resource.
 *
 * The descriptor's resource schema records, per field:
 *  - `name` (the dimension id / measure name / `"status"`),
 *  - `title` (the dimension label, when known),
 *  - `type` (`string` for dimensions/status, `number` for the measure),
 *  - `rdfType` (a role-derived schema.org URL, when a role is assigned).
 *
 * The schema's `primaryKey` is set to all dimension fields — together they
 * uniquely identify an observation. Dataset-level metadata (`label`, `source`,
 * `updated`, `extension`, `roles`, `valueForm`) is emitted as package-level
 * fields and `jsonstat:*` keys, so the round-trip through
 * [`datapackageToCube`] is lossless.
 *
 * @example
 * ```ts
 * import { cubeToDataPackage } from "jsonstat-io/datapackage";
 * const { csv, metadata } = cubeToDataPackage(observations);
 * ```
 */
export function cubeToDataPackage(
  obs: Observations,
  options: CubeToDataPackageOptions = {},
): DataPackageExport {
  const { header, rows } = cubeColumns(obs);
  const csv = serializeRows(header, rows, {
    delimiter: options.delimiter,
    lineTerminator: options.lineTerminator,
  });

  const dimIds = obs.model.dimensionIds;
  const measureName = obs.measure.name ?? "value";
  const hasStatus = obs.status !== undefined;
  const meta = obs.model.meta;

  const fields: DataPackageField[] = [];

  for (const id of dimIds) {
    const col = obs.dimensions[id];
    const role = roleOf(obs, id);
    const rdfType = rdfTypeForRole(role);
    fields.push({
      name: id,
      title: col?.label ?? id,
      type: "string",
      ...(rdfType ? { rdfType } : {}),
    });
  }

  // Measure field: numeric type.
  fields.push({
    name: measureName,
    title: measureName,
    type: "number",
    constraints: { required: false },
  });

  if (hasStatus) {
    fields.push({ name: "status", title: "status", type: "string" });
  }

  const resource: DataPackageResource = {
    name: options.name ?? "data",
    path: options.path ?? "data.csv",
    dialect: { delimiter: options.delimiter ?? ",", header: true },
    schema: {
      fields,
      primaryKey: dimIds.slice(),
      missingValues: [""],
    },
  };

  const metadata: DataPackageMetadata = {
    name: options.name ?? slugify(meta?.label ?? "dataset"),
    resources: [resource],
  };

  if (meta?.label) metadata.title = meta.label;
  if (meta?.source) {
    metadata.sources = [{ title: meta.source }];
  }
  if (meta?.updated) metadata.created = meta.updated;
  if (meta?.extension) metadata["jsonstat:extension"] = meta.extension;
  if (obs.model.roles) metadata["jsonstat:roles"] = obs.model.roles;
  if (obs.model.valueForm) metadata["jsonstat:valueForm"] = obs.model.valueForm;

  return { csv, metadata };
}
