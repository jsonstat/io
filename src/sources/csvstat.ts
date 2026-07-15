/**
 * CSV-stat (JSV) adapter — `jsonstat-io/jsv`.
 *
 * CSV-stat ("JSV") is CSV plus an extra metadata header that round-trips the
 * JSON-stat dataset core: dimensions, category ids/labels/order, roles, metric
 * units, status, and dataset `label`/`source`/`updated`/`href`. See the
 * [format spec](https://jsonstat.org/format/#csv-stat).
 *
 * The structure of a JSV file is:
 *
 * ```
 * jsonstat,{decimal},{unitSep}
 * [label,{text}]
 * [source,{text}]
 * [updated,{text}]
 * [href,{url}]
 * dimension,{id},{label},{size},{catId},{catLabel}×size[,{role}][,{unit}×size]
 * …one dimension line per dimension…
 * data
 * {dimId}…[,status],value
 * {catId}…[,status],{value}
 * …one data record per cell…
 * ```
 *
 * **Import:** [`csvstatToCube`] parses the metadata header + the trailing CSV
 * into the [`Observations`](../model/ir.ts) IR directly (no Arrow hub).
 *
 * **Export:** [`cubeToCsvstat`] writes the IR back to JSV text.
 *
 * @example
 * ```ts
 * import { csvstatToCube, cubeToCsvstat } from "jsonstat-io/jsv";
 * const obs = csvstatToCube(jsvText);
 * const out = cubeToCsvstat(obs);
 * ```
 */

import type { DatasetMeta, DimensionColumn, Observations, RoleMap } from "../model/ir";
import type { JsonStatDataset, JsonStatUnit } from "../model/jsonstat";
import { parseCsv, quoteCsvField } from "./csv";

// ---------------------------------------------------------------------------
// Errors & options
// ---------------------------------------------------------------------------

export class CsvStatSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvStatSourceError";
  }
}

export interface CsvStatToCubeOptions {
  /** CSV column delimiter (default ","). */
  delimiter?: string;
  /**
   * Decimal delimiter override. By default it is read from the `jsonstat`
   * line's first content column (falling back to ".").
   */
  decimal?: string;
  /** Value-form hint passed to the cube model. */
  valueForm?: "auto" | "dense" | "sparse";
}

export interface CubeToCsvStatOptions {
  /** CSV column delimiter (default ","). */
  delimiter?: string;
  /** Decimal delimiter written to the `jsonstat` line (default "."). */
  decimal?: string;
  /** Unit separator written to the `jsonstat` line (default "|"). */
  unitSep?: string;
  /** Line terminator: "\r\n" (RFC-4180 default) or "\n". */
  lineTerminator?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parsed metadata for a single dimension line. */
interface DimMeta {
  id: string;
  label?: string;
  categoryOrder: string[];
  categoryLabels?: Record<string, string>;
  categoryUnits?: Record<string, JsonStatUnit>;
  role?: "geo" | "time" | "metric";
}

const KNOWN_ROLES = new Set(["geo", "time", "metric"]);

/**
 * Parse a unit column ("decimals|label|symbol|position", split on the unit
 * separator) into a [`JsonStatUnit`]. Returns `undefined` for an empty column.
 */
function parseUnit(unitStr: string | undefined, unitSep: string): JsonStatUnit | undefined {
  if (unitStr === undefined || unitStr === "") return undefined;
  const parts = unitStr.split(unitSep);
  const decimalsRaw = parts[0];
  const decimals = decimalsRaw === "" ? 0 : Number(decimalsRaw);
  const unit: JsonStatUnit = {
    decimals: Number.isFinite(decimals) ? decimals : 0,
  };
  if (parts[1] !== undefined && parts[1] !== "") unit.label = parts[1];
  if (parts[2] !== undefined && parts[2] !== "") unit.symbol = parts[2];
  if (parts[3] === "start" || parts[3] === "end") unit.position = parts[3];
  return unit;
}

/** Serialize a [`JsonStatUnit`] back to a unit column string. */
function formatUnit(unit: JsonStatUnit | undefined, unitSep: string): string {
  if (!unit) return "";
  const parts: string[] = [String(unit.decimals ?? 0)];
  parts.push(unit.label ?? "");
  parts.push(unit.symbol ?? "");
  if (unit.position) parts.push(unit.position);
  // Trim trailing empty fields.
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.join(unitSep);
}

/** Parse a `dimension,` metadata row into [`DimMeta`]. */
function parseDimensionRow(row: string[], unitSep: string): DimMeta {
  if (row.length < 4) {
    throw new CsvStatSourceError(
      `Malformed dimension line: expected at least 4 columns, got ${row.length}`,
    );
  }
  const id = row[1];
  const label = row[2];
  const size = Number(row[3]);
  if (!Number.isFinite(size) || size < 0) {
    throw new CsvStatSourceError(`Invalid dimension size "${row[3]}" for dimension "${id}"`);
  }

  const categoryOrder: string[] = [];
  const categoryLabels: Record<string, string> = {};
  let cursor = 4;
  for (let i = 0; i < size; i++) {
    const catId = row[cursor];
    const catLabel = row[cursor + 1];
    cursor += 2;
    if (catId === undefined) {
      throw new CsvStatSourceError(
        `Dimension "${id}" declares size ${size} but has fewer categories`,
      );
    }
    categoryOrder.push(catId);
    categoryLabels[catId] = catLabel ?? catId;
  }

  const dim: DimMeta = { id, label, categoryOrder, categoryLabels };

  // Optional role column, then optional unit columns (metric only).
  if (cursor < row.length && KNOWN_ROLES.has(row[cursor])) {
    const role = row[cursor] as "geo" | "time" | "metric";
    dim.role = role;
    cursor++;
    if (role === "metric") {
      const categoryUnits: Record<string, JsonStatUnit> = {};
      for (let i = 0; i < size && cursor < row.length; i++) {
        const unit = parseUnit(row[cursor], unitSep);
        if (unit) categoryUnits[categoryOrder[i]] = unit;
        cursor++;
      }
      if (Object.keys(categoryUnits).length > 0) dim.categoryUnits = categoryUnits;
    }
  }
  return dim;
}

/**
 * Convert a value cell to a number, honoring the configured decimal delimiter.
 * Non-numeric (or empty) cells become `null` (missing observation).
 */
function parseValueCell(cell: string, decimal: string): number | null {
  if (cell === "") return null;
  let s = cell;
  if (decimal !== ".") s = s.split(decimal).join(".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Format a number for the value column, applying the decimal delimiter. */
function formatValue(v: number, decimal: string): string {
  let s = String(v);
  if (decimal !== ".") s = s.split(".").join(decimal);
  return s;
}

/**
 * Resolve a dimension's category order: use an explicit `categoryOrder` when
 * present, otherwise enumerate distinct values in first-seen order.
 */
function resolveCategoryOrder(col: DimensionColumn | undefined): string[] {
  if (col?.categoryOrder && col.categoryOrder.length > 0) return col.categoryOrder;
  const seen = new Set<string>();
  const order: string[] = [];
  if (col) {
    for (const v of col.values) {
      if (!seen.has(v)) {
        seen.add(v);
        order.push(v);
      }
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// Import: JSV text → Observations IR
// ---------------------------------------------------------------------------

/**
 * Parse CSV-stat (JSV) text into the [`Observations`] IR.
 *
 * @throws [`CsvStatSourceError`] on structural problems.
 */
export function csvstatToCube(text: string, options: CsvStatToCubeOptions = {}): Observations {
  const delimiter = options.delimiter ?? ",";
  const rows = parseCsv(text, delimiter);
  if (rows.length === 0) throw new CsvStatSourceError("JSV has no rows");

  // The first line must be the `jsonstat` line.
  const first = rows[0];
  if (first[0] !== "jsonstat") {
    throw new CsvStatSourceError(`Expected first line tag "jsonstat", got "${first[0] ?? ""}"`);
  }
  const decimal = options.decimal ?? first[1] ?? ".";
  const unitSep = first[2] ?? "|";

  // Walk the metadata header until the `data` line.
  const meta: DatasetMeta = {};
  const dimMap = new Map<string, DimMeta>();
  let dataLineIdx = -1;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const tag = row[0];
    if (tag === "data") {
      dataLineIdx = i;
      break;
    }
    switch (tag) {
      case "label":
        if (row[1] !== undefined) meta.label = row[1];
        break;
      case "source":
        if (row[1] !== undefined) meta.source = row[1];
        break;
      case "updated":
        if (row[1] !== undefined) meta.updated = row[1];
        break;
      case "href":
        if (row[1] !== undefined) meta.href = row[1];
        break;
      case "dimension": {
        const dim = parseDimensionRow(row, unitSep);
        dimMap.set(dim.id, dim);
        break;
      }
      default:
        // Unknown tag: ignore (lenient).
        break;
    }
  }

  if (dataLineIdx === -1) {
    throw new CsvStatSourceError('JSV metadata header is missing a "data" line');
  }

  // CSV section: header + data records.
  const csvRows = rows.slice(dataLineIdx + 1);
  if (csvRows.length === 0) {
    throw new CsvStatSourceError("JSV has no CSV header after the data line");
  }
  const header = csvRows[0];
  if (header.length < 2) {
    throw new CsvStatSourceError(
      "JSV CSV header must have at least one dimension and a value column",
    );
  }
  // The last column is always the value column.
  if (header[header.length - 1] !== "value") {
    throw new CsvStatSourceError(
      `JSV CSV header must end with a "value" column (got "${header[header.length - 1]}")`,
    );
  }
  const valueIdx = header.length - 1;
  // The status column (when present) sits immediately before the value column.
  const hasStatus = header.length >= 3 && header[header.length - 2] === "status";
  const statusIdx = hasStatus ? header.length - 2 : -1;
  const dimEnd = hasStatus ? header.length - 2 : header.length - 1;

  const dimCols: { id: string; idx: number }[] = [];
  for (let c = 0; c < dimEnd; c++) dimCols.push({ id: header[c], idx: c });
  if (dimCols.length === 0) {
    throw new CsvStatSourceError("JSV CSV header has no dimension columns");
  }

  // Drop wholly-empty trailing rows (e.g. a trailing blank line).
  const dataRows = csvRows
    .slice(1)
    .filter((r) => !(r.length === 0 || (r.length === 1 && r[0] === "")));

  // Transpose into columnar arrays.
  const colCount = header.length;
  const columns: string[][] = header.map(() => []);
  for (const r of dataRows) {
    for (let c = 0; c < colCount; c++) columns[c].push(r[c] ?? "");
  }

  // Build dimension columns.
  const dimensions: Record<string, DimensionColumn> = {};
  for (const { id, idx } of dimCols) {
    const dimMeta = dimMap.get(id);
    dimensions[id] = {
      id,
      label: dimMeta?.label,
      values: columns[idx],
      categoryOrder: dimMeta?.categoryOrder,
      categoryLabels: dimMeta?.categoryLabels,
      categoryUnits: dimMeta?.categoryUnits,
    };
  }

  const measure = {
    name: "value",
    values: columns[valueIdx].map((v) => parseValueCell(v, decimal)),
  };

  let status: { values: string[] } | undefined;
  if (hasStatus) {
    status = { values: columns[statusIdx] };
  }

  // Build roles from the dimension lines, in header (dimensionIds) order.
  const roles: RoleMap = {};
  for (const { id } of dimCols) {
    const r = dimMap.get(id)?.role;
    if (r === "time") roles.time = [...(roles.time ?? []), id];
    else if (r === "geo") roles.geo = [...(roles.geo ?? []), id];
    else if (r === "metric") roles.metric = [...(roles.metric ?? []), id];
  }

  const metaClean: DatasetMeta = {};
  if (meta.label) metaClean.label = meta.label;
  if (meta.source) metaClean.source = meta.source;
  if (meta.updated) metaClean.updated = meta.updated;
  if (meta.href) metaClean.href = meta.href;

  return {
    dimensions,
    measure,
    status,
    model: {
      dimensionIds: dimCols.map((d) => d.id),
      roles: roles.time || roles.geo || roles.metric ? roles : undefined,
      meta: Object.keys(metaClean).length > 0 ? metaClean : undefined,
      valueForm: options.valueForm ?? "auto",
      statusForm: status ? "auto" : "none",
    },
  };
}

/** Convenience: JSV text → JSON-stat [`Dataset`]. */
export async function csvstatToDataset(
  text: string,
  options?: CsvStatToCubeOptions,
): Promise<JsonStatDataset> {
  const { toDataset } = await import("../core/cubeBuilder");
  return toDataset(csvstatToCube(text, options));
}

// ---------------------------------------------------------------------------
// Export: Observations IR → JSV text
// ---------------------------------------------------------------------------

/**
 * Write the [`Observations`](../model/ir.ts) IR to CSV-stat (JSV) text.
 *
 * Emits the full metadata header (`jsonstat` line, optional `label`/`source`/
 * `updated`/`href` lines, one `dimension` line per dimension carrying category
 * ids/labels, roles and — for metric dimensions with units — unit columns),
 * the `data` marker, then the tidy CSV records (dimensions [+ status] + value).
 *
 * Null measures are emitted as empty value cells; the value column is always
 * named `value` per the format.
 */
export function cubeToCsvstat(obs: Observations, options: CubeToCsvStatOptions = {}): string {
  const delimiter = options.delimiter ?? ",";
  const decimal = options.decimal ?? ".";
  const unitSep = options.unitSep ?? "|";
  const eol = options.lineTerminator ?? "\r\n";
  const q = (s: string): string => quoteCsvField(s, delimiter);

  const dimIds = obs.model.dimensionIds;
  const meta = obs.model.meta;
  const roles = obs.model.roles;
  const hasStatus = obs.status !== undefined;

  /** Look up the role token for a dimension id. */
  const roleOf = (id: string): "geo" | "time" | "metric" | undefined => {
    if (roles?.time?.includes(id)) return "time";
    if (roles?.geo?.includes(id)) return "geo";
    if (roles?.metric?.includes(id)) return "metric";
    return undefined;
  };

  const lines: string[] = [];

  // jsonstat line.
  lines.push([q("jsonstat"), q(decimal), q(unitSep)].join(delimiter));

  // Optional dataset metadata lines.
  if (meta?.label) lines.push([q("label"), q(meta.label)].join(delimiter));
  if (meta?.source) lines.push([q("source"), q(meta.source)].join(delimiter));
  if (meta?.updated) lines.push([q("updated"), q(meta.updated)].join(delimiter));
  if (meta?.href) lines.push([q("href"), q(meta.href)].join(delimiter));

  // One dimension line per dimension.
  for (const id of dimIds) {
    const col = obs.dimensions[id];
    const order = resolveCategoryOrder(col);
    const labels = col?.categoryLabels;
    const units = col?.categoryUnits;
    const role = roleOf(id);

    const cells: string[] = ["dimension", id, col?.label ?? id, String(order.length)];
    for (const cat of order) {
      cells.push(cat, labels?.[cat] ?? cat);
    }
    if (role) {
      cells.push(role);
      // Unit columns are positional (one per category); emit only when the
      // dimension actually carries unit metadata.
      if (role === "metric" && units && Object.keys(units).length > 0) {
        for (const cat of order) cells.push(formatUnit(units[cat], unitSep));
      }
    }
    lines.push(cells.map(q).join(delimiter));
  }

  // data marker.
  lines.push(q("data"));

  // CSV header: dimensions [+ status] + value.
  const header: string[] = [...dimIds];
  if (hasStatus) header.push("status");
  header.push("value");
  lines.push(header.map(q).join(delimiter));

  // CSV data records.
  const n = obs.measure.values.length;
  for (let i = 0; i < n; i++) {
    const cells: string[] = [];
    for (const id of dimIds) {
      const col = obs.dimensions[id];
      cells.push(col ? col.values[i] : "");
    }
    if (hasStatus) cells.push(obs.status?.values[i] ?? "");
    const v = obs.measure.values[i];
    cells.push(v === null ? "" : formatValue(v, decimal));
    lines.push(cells.map(q).join(delimiter));
  }

  return lines.join(eol) + eol;
}
