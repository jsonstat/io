/**
 * CLI argument parsing helpers — translates the string flags captured by
 * commander into the typed [`ImportOptions`](../index.ts) +
 * [`BuildOptions`](../core/cubeBuilder.ts) the library expects.
 *
 * Kept separate from [`index.ts`](./index.ts) so the parsing logic is unit-
 * testable without spinning up a commander Program.
 */

import type { BuildOptions } from "../core/cubeBuilder";
import type { DatasetMeta } from "../model/ir";
import type { ImportOptions } from "../index";
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
  delimiter?: string;
}

/** Parsed CLI options, ready to feed into `importToDataset` + `serialize`. */
export interface ParsedCliOptions {
  /** Output target: `jsonstat` = import (default); `arrow|parquet|csv|csvw` = export. */
  to: string;
  importOptions: ImportOptions;
  buildOptions: BuildOptions;
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
  "jsonstat",
  "json",
]);

const ALLOWED_TO: ReadonlySet<string> = new Set([
  "jsonstat",
  "arrow",
  "parquet",
  "csv",
  "csvw",
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
export function parseRoleFlag(raw: string | undefined): {
  time?: string[];
  geo?: string[];
  metric?: string[];
} | undefined {
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
      throw new Error(
        `Invalid --role "${role}". Must be one of: time, geo, metric.`,
      );
    }
    if (!col) {
      throw new Error(`--role "${role}=" is missing a column name.`);
    }
    // A role can map to multiple columns (comma-separated within the value
    // is already split above, so each pair is a single column). Accumulate.
    (roles[role] ??= []).push(col);
  }
  return roles;
}

/**
 * Parse the `--dimensions` flag: `a,b,c` → `["a","b","c"]`.
 */
export function parseDimensionsFlag(
  raw: string | undefined,
): string[] | undefined {
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
    throw new Error(
      `--to "${to}" is not supported. Use one of: ${[...ALLOWED_TO].join(", ")}.`,
    );
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
    csvwMetadata: raw.csvwMetadata
      ? safeJsonParse(raw.csvwMetadata, "--csvw-metadata")
      : undefined,
  };

  return {
    to,
    importOptions,
    buildOptions,
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
    throw new Error(
      `${flagName} must be valid JSON: ${(e as Error).message}`,
    );
  }
}
