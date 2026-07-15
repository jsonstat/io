/**
 * CSV adapter — `jsonstat-io/csv`.
 *
 * **Import:** unlike Parquet/DuckDB/Polars (which funnel through the Arrow
 * hub), plain CSV has no native Arrow producer in this package, so this adapter
 * builds the [`Observations`](../model/ir.ts) IR **directly** from parsed rows.
 *
 * **Export:** [`cubeToCsv`] writes the [`Observations`] IR to RFC-4180-style
 * CSV text (dimension columns + measure column + optional status column).
 *
 * ## Mapping heuristics (no metadata)
 *
 * Without a schema, the adapter infers:
 *  - The **measure** is the column named by `options.measure`; failing that,
 *    a column literally named `value` (case-insensitive); failing that, the
 *    first column that parses as a number for every non-empty row.
 *  - Every other column is a **dimension** (string-typed), in file order.
 *  - A column named `status` (case-insensitive) is treated as the status
 *    column unless `options.status` overrides it.
 *
 * Empty cells become `null` in the measure and `""` in dimensions (then
 * rejected by the builder; sources should pre-clean). For richer, lossless
 * mapping with declared types/labels/roles, use CSVW (see [`csvw`](./csvw.ts)).
 */

import type {
  DimensionColumn,
  MeasureColumn,
  Observations,
  RoleMap,
  StatusColumn,
} from "../model/ir";
import type { JsonStatDataset } from "../model/jsonstat";

// ---------------------------------------------------------------------------
// Errors & options
// ---------------------------------------------------------------------------

export class CsvSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvSourceError";
  }
}

export interface CsvToCubeOptions {
  /** Explicit measure column name. Overrides inference. */
  measure?: string;
  /** Explicit dimension column names, in order. */
  dimensions?: string[];
  /** Explicit status column name. Overrides the `status`-name heuristic. */
  status?: string;
  /** Role assignments. */
  roles?: RoleMap;
  /** Value-form hint. */
  valueForm?: "auto" | "dense" | "sparse";
  /** CSV delimiter (default ","). */
  delimiter?: string;
  /** Treat the first row as a header (default true). */
  header?: boolean;
}

// ---------------------------------------------------------------------------
// Minimal CSV parser
// ---------------------------------------------------------------------------

/**
 * A tiny, dependency-free RFC-4180-ish CSV parser. Handles quoted fields,
 * embedded quotes (doubled), and embedded newlines. Sufficient for the
 * importer's needs; for heavy CSV work, prefer piping through DuckDB/Polars.
 */
export function parseCsv(input: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const delim = delimiter.charCodeAt(0);

  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (inQuotes) {
      if (c === 34 /* " */) {
        // Doubled quote → literal quote; otherwise end quote.
        if (input.charCodeAt(i + 1) === 34) {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += input[i];
      }
    } else {
      if (c === 34) {
        inQuotes = true;
      } else if (c === delim) {
        row.push(field);
        field = "";
      } else if (c === 13 /* \r */) {
        // swallow; handle \n
        if (input.charCodeAt(i + 1) === 10) i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === 10 /* \n */) {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += input[i];
      }
    }
  }
  // Flush trailing field/row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

/** Does every non-empty value parse as a finite number? */
function isAllNumeric(values: string[]): boolean {
  let any = false;
  for (const v of values) {
    if (v === "") continue;
    any = true;
    const n = Number(v);
    if (!Number.isFinite(n)) return false;
  }
  return any;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse CSV text into the [`Observations`] IR.
 *
 * @throws [`CsvSourceError`] on structural problems.
 */
export function csvToCube(text: string, options: CsvToCubeOptions = {}): Observations {
  const delimiter = options.delimiter ?? ",";
  const header = options.header ?? true;
  const rows = parseCsv(text, delimiter);
  if (rows.length === 0) throw new CsvSourceError("CSV has no rows");

  let headerNames: string[];
  let dataRows: string[][];
  if (header) {
    headerNames = rows[0];
    dataRows = rows.slice(1);
  } else {
    headerNames = rows[0].map((_, i) => `col${i}`);
    dataRows = rows;
  }
  if (headerNames.length === 0) throw new CsvSourceError("CSV header is empty");
  if (dataRows.length === 0) throw new CsvSourceError("CSV has no data rows");

  const colCount = headerNames.length;

  // Transpose into columnar arrays for inference.
  const columns: string[][] = headerNames.map(() => []);
  for (const r of dataRows) {
    // Pad/truncate to header length.
    for (let c = 0; c < colCount; c++) columns[c].push(r[c] ?? "");
  }

  // Resolve measure column. Precedence: explicit option.measure > a column
  // named "value" (case-insensitive) > first all-numeric column (inference).
  let measureIdx = headerNames.findIndex((n) => n === options.measure);
  if (measureIdx === -1 && !options.measure) {
    measureIdx = headerNames.findIndex((n) => n.toLowerCase() === "value");
  }
  if (measureIdx === -1) {
    // Inference: first all-numeric column.
    measureIdx = columns.findIndex((col) => isAllNumeric(col));
    if (measureIdx === -1) {
      throw new CsvSourceError(
        "No measure column found: no column is named 'value' or is fully " +
          "numeric. Pass options.measure to name one (values will be parsed " +
          "with Number()).",
      );
    }
  }

  // Resolve status column.
  let statusIdx = headerNames.findIndex((n) => n === options.status);
  if (statusIdx === -1 && !options.status) {
    statusIdx = headerNames.findIndex((n) => n.toLowerCase() === "status");
    if (statusIdx === measureIdx) statusIdx = -1;
  }

  // Resolve dimensions: everything that's not measure or status.
  let dimensionIdxs: number[];
  if (options.dimensions) {
    dimensionIdxs = options.dimensions.map((n) => {
      const idx = headerNames.indexOf(n);
      if (idx === -1) throw new CsvSourceError(`Dimension column "${n}" not found in CSV header`);
      return idx;
    });
  } else {
    dimensionIdxs = headerNames.map((_, i) => i).filter((i) => i !== measureIdx && i !== statusIdx);
    if (dimensionIdxs.length === 0) {
      throw new CsvSourceError("No dimension columns remain after measure/status selection");
    }
  }

  const n = dataRows.length;
  const dimensions: Record<string, DimensionColumn> = {};
  for (const idx of dimensionIdxs) {
    const name = headerNames[idx];
    dimensions[name] = {
      id: name,
      values: columns[idx].map((v) => (v === "" ? "" : v)),
    };
  }

  const measure: MeasureColumn = {
    name: headerNames[measureIdx],
    values: columns[measureIdx].map((v) => (v === "" ? null : Number(v))),
  };

  let status: StatusColumn | undefined;
  if (statusIdx !== -1) {
    status = { values: columns[statusIdx].map((v) => v) };
  }

  const observations: Observations = {
    dimensions,
    measure,
    status,
    model: {
      dimensionIds: dimensionIdxs.map((i) => headerNames[i]),
      roles: options.roles,
      valueForm: options.valueForm ?? "auto",
      statusForm: status ? "auto" : "none",
    },
  };
  // n unused guard (kept for clarity; columns already encode length).
  void n;

  return observations;
}

/** Convenience: CSV text → JSON-stat [`Dataset`]. */
export async function csvToDataset(
  text: string,
  options?: CsvToCubeOptions,
): Promise<JsonStatDataset> {
  const { toDataset } = await import("../core/cubeBuilder");
  return toDataset(csvToCube(text, options));
}

// ---------------------------------------------------------------------------
// Export: Observations IR → CSV text
// ---------------------------------------------------------------------------

export interface CubeToCsvOptions {
  /** CSV delimiter (default ","). */
  delimiter?: string;
  /** Line terminator: "\r\n" (RFC-4180 default) or "\n". */
  lineTerminator?: string;
}

/**
 * Resolve the ordered list of (column name, row value extractor) pairs for a
 * dataset IR. Shared by [`cubeToCsv`] and [`cubeToCsvw`] so the two writers
 * agree on column layout.
 *
 * Column order: dimension IDs (in `model.dimensionIds` order) → measure
 * (named `measure.name ?? "value"`) → status (`"status"`, if present).
 *
 * @internal
 */
export function cubeColumns(obs: Observations): {
  header: string[];
  rows: string[];
} {
  const dimIds = obs.model.dimensionIds;
  const measureName = obs.measure.name ?? "value";
  const hasStatus = obs.status !== undefined;

  const header: string[] = [...dimIds, measureName];
  if (hasStatus) header.push("status");

  const n = obs.measure.values.length;
  const rows: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const cells: string[] = [];
    for (const id of dimIds) {
      const col = obs.dimensions[id];
      cells.push(col ? col.values[i] : "");
    }
    const v = obs.measure.values[i];
    cells.push(v === null ? "" : String(v));
    if (hasStatus) cells.push(obs.status!.values[i] ?? "");
    rows[i] = cells.join("\u0000"); // placeholder; real delimiter applied later
  }
  return { header, rows };
}

/**
 * Quote a single CSV field per RFC-4180. A field needs quoting if it contains
 * the delimiter, a double quote, a CR, or an LF. Embedded quotes are doubled.
 */
export function quoteCsvField(value: string, delimiter: string, force = false): string {
  const needsQuoting =
    force ||
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\r") ||
    value.includes("\n");
  if (!needsQuoting) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Serialize a CSV header + rows (as produced by [`cubeColumns`]) into RFC-4180
 * text. Extracted so CSV and CSVW writers share one escaping path.
 *
 * @internal
 */
export function serializeRows(
  header: string[],
  rows: string[],
  options: CubeToCsvOptions = {},
): string {
  const delimiter = options.delimiter ?? ",";
  const eol = options.lineTerminator ?? "\r\n";
  const parts: string[] = [];
  parts.push(header.map((h) => quoteCsvField(h, delimiter)).join(delimiter));
  for (const row of rows) {
    const cells = row.split("\u0000");
    parts.push(cells.map((c) => quoteCsvField(c, delimiter)).join(delimiter));
  }
  return parts.join(eol) + eol;
}

/**
 * Write the [`Observations`](../model/ir.ts) IR to RFC-4180-style CSV text.
 *
 * The output is a tidy long table: one header row + one row per observation.
 * Columns are the dimension IDs (in `model.dimensionIds` order), then the
 * measure column (`measure.name ?? "value"`), then an optional `status`
 * column. Null measures are emitted as empty cells.
 *
 * This is the lossy inverse of [`csvToCube`]: labels, roles, and category
 * metadata are not preserved (use [`cubeToCsvw`] for a lossless export).
 *
 * @example
 * ```ts
 * import { cubeToCsv } from "jsonstat-io/csv";
 * const csv = cubeToCsv(observations);
 * ```
 */
export function cubeToCsv(obs: Observations, options: CubeToCsvOptions = {}): string {
  const { header, rows } = cubeColumns(obs);
  return serializeRows(header, rows, options);
}
