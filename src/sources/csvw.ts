/**
 * CSVW (CSV on the Web) adapter — `jsonstat-io/csvw`.
 *
 * **Import:** CSVW pairs a CSV file with a JSON-LD metadata document that
 * declares a `tableSchema` — column names, types, `titles` (human labels),
 * `primaryKey`, and property URLs. This metadata enables a **lossless** mapping
 * straight to the [`Observations`](../model/ir.ts) IR, without the inference
 * heuristics of plain [`csv`](./csv.ts).
 *
 * **Export:** [`cubeToCsvw`] generates both the CSV text and a CSVW metadata
 * document from the [`Observations`] IR.
 *
 * ## Mapping
 *
 *  - Columns whose `datatype` is numeric → measure candidates.
 *  - The measure is the first numeric column, or the one flagged via
 *    `options.measure`. Other columns are dimensions.
 *  - `tableSchema.primaryKey` columns are treated as dimensions (and can pin
 *    the dimension order via `options.dimensions`).
 *  - `titles` → dimension/category labels; `name` → dimension id.
 *  - `primaryKey` → dimension id list (used as `dimensionIds` when
 *    `options.dimensions` is not given).
 *  - `propertyUrl` containing `time`/`geo`/`metric` → role hints.
 *
 * The adapter does not implement the full CSVW spec (foreign keys, URL
 * templates, cell value transformations); it covers the subset needed to
 * faithfully round-trip statistical cubes. See [docs/formats/csvw.md](../../docs/formats/csvw.md).
 */

import type {
  DimensionColumn,
  MeasureColumn,
  Observations,
  RoleMap,
  StatusColumn,
} from "../model/ir";
import type { JsonStatDataset } from "../model/jsonstat";
import { cubeColumns, parseCsv, serializeRows } from "./csv";

// ---------------------------------------------------------------------------
// Errors & CSVW metadata types
// ---------------------------------------------------------------------------

export class CsvwSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvwSourceError";
  }
}

/** A column declaration in a CSVW `tableSchema`. */
export interface CsvwColumn {
  name: string;
  titles?: string | string[];
  datatype?: string | { base: string };
  propertyUrl?: string;
  /** CSVW virtual columns are not backed by a CSV cell. */
  virtual?: boolean;
  /** Default value for missing cells. */
  default?: string;
  /** Whether null is allowed. */
  required?: boolean;
}

/** The `tableSchema` object from a CSVW metadata document. */
export interface CsvwTableSchema {
  columns: CsvwColumn[];
  primaryKey?: string | string[];
  /** Foreign keys are parsed but not enforced. */
  foreignKeys?: unknown[];
}

/** A trimmed CSVW metadata document (only the fields we use). */
export interface CsvwMetadata {
  url?: string;
  "@context"?: string | unknown[];
  "dc:title"?: string;
  "dc:source"?: string;
  "dcat:modified"?: string;
  tableSchema: CsvwTableSchema;
  /**
   * Extension object: if present, attached to the dataset as `extension`.
   * CSVW doesn't standardize this; consumers may add `jsonstat:*` keys here.
   */
  "jsonstat:extension"?: Record<string, unknown>;
  "jsonstat:roles"?: RoleMap;
  "jsonstat:valueForm"?: "auto" | "dense" | "sparse";
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CsvwToCubeOptions {
  /** Explicit measure column name. Overrides schema-based detection. */
  measure?: string;
  /** Explicit dimension column names, in order. */
  dimensions?: string[];
  /** Explicit status column name. */
  status?: string;
  /** Role assignments (merged with, and overriding, metadata hints). */
  roles?: RoleMap;
  /** CSV delimiter (default ","). */
  delimiter?: string;
  /** Treat the CSV's first row as a header (default true). */
  header?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstTitle(col: CsvwColumn): string | undefined {
  if (!col.titles) return undefined;
  return Array.isArray(col.titles) ? col.titles[0] : col.titles;
}

/** Is a CSVW datatype numeric? */
function isNumericDatatype(dt: string | { base: string } | undefined): boolean {
  if (!dt) return false;
  const base = typeof dt === "string" ? dt : dt.base;
  return (
    base === "decimal" ||
    base === "integer" ||
    base === "double" ||
    base === "float" ||
    base === "number" ||
    base === "long" ||
    base === "int" ||
    base === "short" ||
    base === "byte"
  );
}

/** Infer a role from a CSVW propertyUrl. */
function roleFromPropertyUrl(url: string | undefined): "time" | "geo" | "metric" | undefined {
  if (!url) return undefined;
  const u = url.toLowerCase();
  if (u.includes("time") || u.includes("date")) return "time";
  if (u.includes("geo") || u.includes("spatial") || u.includes("place")) return "geo";
  if (u.includes("metric") || u.includes("measure") || u.includes("obsvalue")) return "metric";
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert CSV text + CSVW metadata into the [`Observations`] IR.
 *
 * @param csvText The raw CSV file content.
 * @param metadata The parsed CSVW metadata document (the `tableSchema` is
 *        required).
 * @throws [`CsvwSourceError`] on structural problems.
 */
export function csvwToCube(
  csvText: string,
  metadata: CsvwMetadata,
  options: CsvwToCubeOptions = {},
): Observations {
  if (!metadata.tableSchema?.columns?.length) {
    throw new CsvwSourceError("CSVW metadata is missing tableSchema.columns");
  }

  const delimiter = options.delimiter ?? ",";
  const header = options.header ?? true;
  const schema = metadata.tableSchema;

  // The CSVW column `name` is the canonical header. If the CSV has its own
  // header row, we expect it to match the `name`s (or `titles`); if not, we
  // rely on column position. To be robust, we parse by position and label by
  // the schema's `name`.
  const rows = parseCsv(csvText, delimiter);
  if (rows.length === 0) throw new CsvwSourceError("CSV has no rows");

  let dataRows: string[][];
  if (header) {
    dataRows = rows.slice(1);
  } else {
    dataRows = rows;
  }
  const cols = schema.columns.filter((c) => !c.virtual);
  const colCount = cols.length;
  if (dataRows.length === 0) throw new CsvwSourceError("CSV has no data rows");

  // Read each CSVW column into a string array (by position).
  const columnValues: string[][] = cols.map(() => []);
  for (const r of dataRows) {
    for (let c = 0; c < colCount; c++) {
      const cell = r[c] ?? cols[c].default ?? "";
      columnValues[c].push(cell);
    }
  }

  // Resolve measure. Precedence: explicit option.measure > a column named
  // "value" (case-insensitive) > first numeric-datatype column.
  let measureIdx = cols.findIndex((c) => c.name === options.measure);
  if (measureIdx === -1 && !options.measure) {
    measureIdx = cols.findIndex((c) => c.name.toLowerCase() === "value");
  }
  if (measureIdx === -1) {
    measureIdx = cols.findIndex((c) => isNumericDatatype(c.datatype));
    if (measureIdx === -1) {
      throw new CsvwSourceError(
        "No measure column: no column is named 'value' or has a numeric " +
          "datatype. Pass options.measure to name one.",
      );
    }
  }

  // Resolve status: explicit > a column named/propertyUrl'd 'status'.
  let statusIdx = cols.findIndex((c) => c.name === options.status);
  if (statusIdx === -1 && !options.status) {
    statusIdx = cols.findIndex(
      (c) =>
        c.name.toLowerCase() === "status" ||
        (roleFromPropertyUrl(c.propertyUrl) === undefined && c.name.toLowerCase() === "status"),
    );
    if (statusIdx === measureIdx) statusIdx = -1;
  }

  // Resolve dimensions.
  let dimensionIdxs: number[];
  if (options.dimensions) {
    dimensionIdxs = options.dimensions.map((n) => {
      const idx = cols.findIndex((c) => c.name === n);
      if (idx === -1) throw new CsvwSourceError(`Dimension column "${n}" not in schema`);
      return idx;
    });
  } else {
    // Prefer primaryKey columns as dimensions, in declared order; fall back to
    // all non-measure/non-status columns.
    const pk = schema.primaryKey
      ? Array.isArray(schema.primaryKey)
        ? schema.primaryKey
        : [schema.primaryKey]
      : [];
    if (pk.length > 0) {
      dimensionIdxs = pk.map((n) => {
        const idx = cols.findIndex((c) => c.name === n);
        if (idx === -1) throw new CsvwSourceError(`primaryKey column "${n}" not in schema`);
        return idx;
      });
      // Append any remaining non-measure/non-status columns not in the PK.
      for (let i = 0; i < cols.length; i++) {
        if (i === measureIdx || i === statusIdx || dimensionIdxs.includes(i)) continue;
        dimensionIdxs.push(i);
      }
    } else {
      dimensionIdxs = cols.map((_, i) => i).filter((i) => i !== measureIdx && i !== statusIdx);
    }
  }
  if (dimensionIdxs.length === 0) {
    throw new CsvwSourceError("No dimension columns resolved");
  }

  // Build dimension columns, pulling labels from `titles`.
  const dimensions: Record<string, DimensionColumn> = {};
  for (const idx of dimensionIdxs) {
    const col = cols[idx];
    const label = firstTitle(col);
    dimensions[col.name] = {
      id: col.name,
      values: columnValues[idx].map((v) => (v === "" ? "" : v)),
      label,
    };
  }

  // Measure: parse numerically per the datatype.
  const measure: MeasureColumn = {
    name: cols[measureIdx].name,
    values: columnValues[measureIdx].map((v) => {
      if (v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }),
  };

  let status: StatusColumn | undefined;
  if (statusIdx !== -1) {
    status = { values: columnValues[statusIdx].slice() };
  }

  // Roles: metadata hints + propertyUrl inference + caller overrides.
  const roles: RoleMap = {};
  const addRole = (role: keyof RoleMap, id: string) => {
    roles[role] = [...(roles[role] ?? []), id];
  };
  if (metadata["jsonstat:roles"]) {
    for (const r of ["time", "geo", "metric"] as const) {
      for (const id of metadata["jsonstat:roles"][r] ?? []) addRole(r, id);
    }
  }
  for (const idx of dimensionIdxs) {
    const role = roleFromPropertyUrl(cols[idx].propertyUrl);
    if (role) addRole(role, cols[idx].name);
  }
  // The measure, if it has a metric propertyUrl, records the metric role on
  // itself (it is not a dimension, so this is informational).
  if (options.roles) {
    for (const r of ["time", "geo", "metric"] as const) {
      for (const id of options.roles[r] ?? []) addRole(r, id);
    }
  }

  const observations: Observations = {
    dimensions,
    measure,
    status,
    model: {
      dimensionIds: dimensionIdxs.map((i) => cols[i].name),
      roles: Object.keys(roles).length ? roles : undefined,
      meta: {
        label: metadata["dc:title"],
        source: metadata["dc:source"],
        updated: metadata["dcat:modified"],
        extension: metadata["jsonstat:extension"],
      },
      valueForm: metadata["jsonstat:valueForm"] ?? "auto",
      statusForm: status ? "auto" : "none",
    },
  };

  return observations;
}

/** Convenience: CSVW (CSV + metadata) → JSON-stat [`Dataset`]. */
export async function csvwToDataset(
  csvText: string,
  metadata: CsvwMetadata,
  options?: CsvwToCubeOptions,
): Promise<JsonStatDataset> {
  const { toDataset } = await import("../core/cubeBuilder");
  return toDataset(csvwToCube(csvText, metadata, options));
}

/** Parse a CSVW metadata JSON document, validating minimally. */
export function parseCsvwMetadata(json: unknown): CsvwMetadata {
  const m = json as CsvwMetadata;
  if (!m || !m.tableSchema || !Array.isArray(m.tableSchema.columns)) {
    throw new CsvwSourceError("Invalid CSVW metadata: missing tableSchema.columns");
  }
  return m;
}

// ---------------------------------------------------------------------------
// Export: Observations IR → CSVW (CSV text + metadata JSON)
// ---------------------------------------------------------------------------

export interface CubeToCsvwOptions {
  /** CSV delimiter (default ","). */
  delimiter?: string;
  /** Line terminator: "\r\n" (default) or "\n". */
  lineTerminator?: string;
  /**
   * The `url` of the CSV file the metadata describes. Required by the CSVW
   * spec for a stand-alone metadata document; falls back to `"data.csv"`.
   */
  url?: string;
}

/** Result of [`cubeToCsvw`]: the CSV body + the CSVW metadata document. */
export interface CsvwExport {
  /** The CSV text (header + rows). */
  csv: string;
  /** The CSVW metadata document, ready to `JSON.stringify`. */
  metadata: CsvwMetadata;
}

/** JSON-stat role → CSVW `propertyUrl` template fragment. */
function propertyUrlForRole(role: "time" | "geo" | "metric" | undefined): string | undefined {
  if (role === "time") return "schema:DateTime";
  if (role === "geo") return "schema:Place";
  if (role === "metric") return "schema:Measure";
  return undefined;
}

/** Look up the role of a dimension id in the IR model. */
function roleOf(obs: Observations, id: string): "time" | "geo" | "metric" | undefined {
  const roles = obs.model.roles;
  if (!roles) return undefined;
  if (roles.time?.includes(id)) return "time";
  if (roles.geo?.includes(id)) return "geo";
  if (roles.metric?.includes(id)) return "metric";
  return undefined;
}

/**
 * Write the [`Observations`](../model/ir.ts) IR to a CSVW pair: the CSV text
 * (RFC-4180) and a CSVW metadata document declaring the `tableSchema`.
 *
 * The metadata records, per column:
 *  - `name` (the dimension id / measure name / `"status"`),
 *  - `titles` (the dimension label, when known),
 *  - `datatype` (`string` for dimensions/status, `decimal` for the measure),
 *  - `propertyUrl` (a role-derived schema.org URL, when a role is assigned).
 *
 * The schema's `primaryKey` is set to all dimension columns — together they
 * uniquely identify an observation. Dataset-level metadata (`label`, `source`,
 * `updated`, `extension`, `roles`, `valueForm`) is emitted as the CSVW
 * `dc:title` / `dc:source` / `dcat:modified` / `jsonstat:*` keys, so the
 * round-trip through [`csvwToCube`] is lossless.
 *
 * @example
 * ```ts
 * import { cubeToCsvw } from "jsonstat-io/csvw";
 * const { csv, metadata } = cubeToCsvw(observations);
 * ```
 */
export function cubeToCsvw(obs: Observations, options: CubeToCsvwOptions = {}): CsvwExport {
  const { header, rows } = cubeColumns(obs);
  const csv = serializeRows(header, rows, options);

  const dimIds = obs.model.dimensionIds;
  const measureName = obs.measure.name ?? "value";
  const hasStatus = obs.status !== undefined;
  const meta = obs.model.meta;

  const columns: CsvwColumn[] = [];

  for (const id of dimIds) {
    const col = obs.dimensions[id];
    const role = roleOf(obs, id);
    const propUrl = propertyUrlForRole(role);
    columns.push({
      name: id,
      titles: col?.label ?? id,
      datatype: "string",
      ...(propUrl ? { propertyUrl: propUrl } : {}),
    });
  }

  // Measure column: numeric datatype.
  columns.push({
    name: measureName,
    titles: measureName,
    datatype: "decimal",
    propertyUrl: "schema:value",
    required: false,
  });

  if (hasStatus) {
    columns.push({
      name: "status",
      titles: "status",
      datatype: "string",
    });
  }

  const metadata: CsvwMetadata = {
    url: options.url ?? "data.csv",
    "@context": ["http://www.w3.org/ns/csvw", { "@language": "en" }],
    tableSchema: {
      columns,
      primaryKey: dimIds.slice(),
    },
  };

  if (meta?.label) metadata["dc:title"] = meta.label;
  if (meta?.source) metadata["dc:source"] = meta.source;
  if (meta?.updated) metadata["dcat:modified"] = meta.updated;
  if (meta?.extension) metadata["jsonstat:extension"] = meta.extension;
  if (obs.model.roles) metadata["jsonstat:roles"] = obs.model.roles;
  if (obs.model.valueForm) metadata["jsonstat:valueForm"] = obs.model.valueForm;

  return { csv, metadata };
}
