/**
 * CLI argument parsing helpers — translates the string flags captured by
 * commander into the typed [`ImportOptions`](../index.ts) +
 * [`BuildOptions`](../core/cubeBuilder.ts) the library expects.
 *
 * Kept separate from [`index.ts`](./index.ts) so the parsing logic is unit-
 * testable without spinning up a commander Program.
 */

import type { BuildOptions } from "../core/cubeBuilder";
import type { ExportOptions, ImportOptions } from "../index";
import type { DatasetMeta } from "../model/ir";
import type { SourceFormat } from "../util/detect";

/** The raw option bag that commander collects from argv. */
export interface RawCliOptions {
  from?: string;
  to?: string;
  measure?: string;
  dimensions?: string;
  role?: string;
  status?: string;
  sparse?: boolean;
  dense?: boolean;
  auto?: boolean;
  threshold?: string;
  statusForm?: string;
  label?: string;
  source?: string;
  updated?: string;
  validate?: boolean;
  output?: string;
  pretty?: boolean;
  noPretty?: boolean;
  canonicalKeys?: boolean;
  noCanonicalKeys?: boolean;
  csvwMetadata?: string;
  datapackageMetadata?: string;
  delimiter?: string;
  /** CSV-stat (JSV) / export decimal delimiter (`--decimal`). */
  decimal?: string;
  /** CSV-stat (JSV) / export unit separator (`--unit-sep`). */
  unitSep?: string;
  /** Line terminator for CSV/CSVW/CSV-stat/Data Package export (`--line-terminator`). */
  lineTerminator?: string;
}

/** Parsed CLI options, ready to feed into `importToDataset` + `serialize`. */
export interface ParsedCliOptions {
  /** Output target: `jsonstat` = import (default); `arrow|parquet|csv|csvw|jsv|datapackage` = export. */
  to: string;
  importOptions: ImportOptions;
  buildOptions: BuildOptions;
  /** Export options for the `--to arrow|parquet|csv|csvw|jsv|datapackage` path. */
  exportOptions: ExportOptions;
  /** `--validate` flag. */
  validate: boolean;
  /** Output file path (`-o` / `--output`), or undefined for stdout. */
  output?: string;
  /** Pretty-print the JSON output (default true). */
  pretty: boolean;
  /** Reorder top-level keys canonically (default true). */
  canonicalKeys: boolean;
}

const ALLOWED_FROM: ReadonlySet<string> = new Set([
  "auto",
  "parquet",
  "arrow",
  "csv",
  "csvw",
  "jsv",
  "datapackage",
  "jsonstat",
  "json",
]);

const ALLOWED_TO: ReadonlySet<string> = new Set([
  "jsonstat",
  "arrow",
  "parquet",
  "csv",
  "csvw",
  "jsv",
  "datapackage",
]);

const ALLOWED_STATUS_FORM: ReadonlySet<string> = new Set([
  "auto",
  "array",
  "string",
  "object",
  "none",
]);

/**
 * Parse the `--role` flag: `time=year,geo=country,metric=value` → a
 * [`RoleMap`](../model/ir.ts).
 */
export function parseRoleFlag(raw: string | undefined):
  | {
      time?: string[];
      geo?: string[];
      metric?: string[];
    }
  | undefined {
  if (!raw) return undefined;
  const roles: { time?: string[]; geo?: string[]; metric?: string[] } = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) {
      throw new Error(
        `Invalid --role entry "${pair}". Expected "<role>=<column>" (e.g. time=year).`,
      );
    }
    const role = pair.slice(0, eq).trim();
    const col = pair.slice(eq + 1).trim();
    if (role !== "time" && role !== "geo" && role !== "metric") {
      throw new Error(`Invalid --role "${role}". Must be one of: time, geo, metric.`);
    }
    if (!col) {
      throw new Error(`--role "${role}=" is missing a column name.`);
    }
    // A role can map to multiple columns (comma-separated within the value
    // is already split above, so each pair is a single column). Accumulate.
    roles[role] = [...(roles[role] ?? []), col];
  }
  return roles;
}

/**
 * Parse the `--dimensions` flag: `a,b,c` → `["a","b","c"]`.
 */
export function parseDimensionsFlag(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const dims = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (dims.length === 0) {
    throw new Error("--dimensions requires at least one column name.");
  }
  return dims;
}

/**
 * Parse a `--threshold` value (0–1) with a friendly error.
 */
export function parseThreshold(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n) || n < 0 || n > 1) {
    throw new Error(`--threshold must be a number between 0 and 1, got "${raw}".`);
  }
  return n;
}

/**
 * Resolve the `--sparse` / `--dense` / `--auto` trio into a `valueForm`.
 * `--sparse` wins over `--dense` if both are set (defensive).
 */
export function resolveValueForm(raw: RawCliOptions): "auto" | "dense" | "sparse" {
  if (raw.sparse) return "sparse";
  if (raw.dense) return "dense";
  return "auto";
}

/**
 * Slugify a string into a URL-safe Data Package `name` slug. Mirrors the
 * `slugify` rule in [`sources/datapackage`](../sources/datapackage.ts) so the
 * CLI and the writer default agree.
 */
function slugifyName(stem: string): string {
  return (
    stem
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "dataset"
  );
}

/**
 * Derive a Data Package resource `path` (the CSV filename) and `name` slug
 * from the `-o` / `--output` flag.
 *
 * `path` is the basename only (e.g. `data/sub/cube.csv` → `"cube.csv"`):
 * the descriptor is written as a sibling of the CSV, so the resource `path`
 * is relative to that same directory. The stem (extension stripped) feeds
 * `name` through [`slugifyName`].
 *
 * Returns `undefined` for both when `output` is absent or `"-"` (stdout), so
 * the writer's own defaults (`slugify(meta.label)` / `"data.csv"`) apply.
 */
export function deriveDataPackageNamePath(output: string | undefined): {
  datapackageName?: string;
  datapackagePath?: string;
} {
  if (!output || output === "-") return {};
  // basename across both POSIX and Windows separators
  const slash = Math.max(output.lastIndexOf("/"), output.lastIndexOf("\\"));
  const basename = slash >= 0 ? output.slice(slash + 1) : output;
  if (basename === "") return {};
  const dot = basename.lastIndexOf(".");
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  return { datapackageName: slugifyName(stem), datapackagePath: basename };
}

/**
 * Build the [`ExportOptions`](../index.ts) for the `--to` (export) path from
 * the raw CLI flags.
 *
 * The `to` field is intentionally NOT set here — the caller (`runExport`)
 * owns it. This forwards the format-specific knobs (`delimiter`,
 * `lineTerminator`, `decimal`, `unitSep`) that the previous implementation
 * dropped, and derives the Data Package `name`/`path` from `-o`.
 */
/**
 * Normalize a `--line-terminator` flag value into a real line terminator.
 * Accepts the literals `\n` / `\r\n` (as typed on the shell, i.e. backslash-n),
 * the words `lf` / `crlf`, and `\r`. Anything else is passed through verbatim.
 */
function normalizeLineTerminator(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "\\n" || v === "lf") return "\n";
  if (v === "\\r\\n" || v === "crlf") return "\r\n";
  if (v === "\\r" || v === "cr") return "\r";
  return value;
}

export function buildExportOptions(raw: RawCliOptions): ExportOptions {
  const { datapackageName, datapackagePath } = deriveDataPackageNamePath(raw.output);
  return {
    to: "csv", // placeholder; the caller overrides via spread.
    delimiter: raw.delimiter,
    decimal: raw.decimal,
    unitSep: raw.unitSep,
    lineTerminator: normalizeLineTerminator(raw.lineTerminator),
    ...(datapackageName ? { datapackageName } : {}),
    ...(datapackagePath ? { datapackagePath } : {}),
  };
}

/**
 * Convert the raw commander option bag into typed library options.
 *
 * @throws Error with a user-friendly message if any flag is invalid.
 */
export function parseCliOptions(raw: RawCliOptions): ParsedCliOptions {
  // --- --from -----------------------------------------------------------
  if (raw.from !== undefined && !ALLOWED_FROM.has(raw.from)) {
    throw new Error(
      `--from "${raw.from}" is not supported. Use one of: ${[...ALLOWED_FROM].join(", ")}.`,
    );
  }

  // --- --to (drives direction: jsonstat = import, else export) ----------
  const to = raw.to ?? "jsonstat";
  if (!ALLOWED_TO.has(to)) {
    throw new Error(`--to "${to}" is not supported. Use one of: ${[...ALLOWED_TO].join(", ")}.`);
  }

  // --- --status-form ----------------------------------------------------
  if (raw.statusForm !== undefined && !ALLOWED_STATUS_FORM.has(raw.statusForm)) {
    throw new Error(
      `--status-form "${raw.statusForm}" is invalid. Use one of: ${[...ALLOWED_STATUS_FORM].join(", ")}.`,
    );
  }

  // --- Dataset metadata -------------------------------------------------
  const meta: DatasetMeta = {};
  if (raw.label) meta.label = raw.label;
  if (raw.source) meta.source = raw.source;
  if (raw.updated) meta.updated = raw.updated;

  // --- Build options ----------------------------------------------------
  const buildOptions: BuildOptions = {
    valueForm: resolveValueForm(raw),
    sparseThreshold: parseThreshold(raw.threshold),
    statusForm: raw.statusForm as BuildOptions["statusForm"],
    meta: Object.keys(meta).length > 0 ? meta : undefined,
  };

  // --- Import options ---------------------------------------------------
  const importOptions: ImportOptions = {
    from: (raw.from ?? "auto") as SourceFormat | "auto",
    measure: raw.measure,
    dimensions: parseDimensionsFlag(raw.dimensions),
    status: raw.status,
    roles: parseRoleFlag(raw.role),
    build: buildOptions,
    delimiter: raw.delimiter,
    csvwMetadata: raw.csvwMetadata ? safeJsonParse(raw.csvwMetadata, "--csvw-metadata") : undefined,
    datapackageMetadata: raw.datapackageMetadata
      ? safeJsonParse(raw.datapackageMetadata, "--datapackage-metadata")
      : undefined,
  };

  return {
    to,
    importOptions,
    buildOptions,
    exportOptions: buildExportOptions(raw),
    validate: raw.validate === true,
    output: raw.output,
    pretty: raw.noPretty ? false : (raw.pretty ?? true),
    canonicalKeys: raw.noCanonicalKeys ? false : (raw.canonicalKeys ?? true),
  };
}

function safeJsonParse(text: string, flagName: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${flagName} must be valid JSON: ${(e as Error).message}`);
  }
}
