#!/usr/bin/env node
/**
 * jsonstat-io CLI entry point.
 *
 * `--to` drives direction:
 *  - `--to jsonstat` (default): import a columnar source → JSON-stat (Phase 1).
 *  - `--to arrow|parquet|csv|csvw`: export a JSON-stat dataset → columnar (Phase 2).
 *
 * Usage:
 *
 * ```sh
 * npx jsonstat-io <input> [options]
 * npx jsonstat-io ./sales.parquet -o sales.jsonstat.json
 * cat data.csv | npx jsonstat-io - --measure amount --role time=year
 * npx jsonstat-io https://example.com/data.arrow --sparse --label "Sales 2024"
 * npx jsonstat-io ./census.jsonstat.json --to parquet -o census.parquet
 * ```
 *
 * See [docs/cli.md](../../docs/cli.md) for the full reference.
 *
 * @module
 */

import { Command } from "commander";
import { tableToIPC } from "apache-arrow";
import type { Table } from "apache-arrow";
import { fileURLToPath } from "node:url";
import {
  importToDataset,
  exportDataset,
  serialize,
  ImporterError,
} from "../index";
import type { ExportTarget } from "../index";
import type { JsonStatDataset } from "../model/jsonstat";
import { parseCliOptions } from "./args";
import type { RawCliOptions } from "./args";

// ---------------------------------------------------------------------------
// File writing (Node only) — kept inline to avoid pulling node:fs in browser
// builds of the library proper.
// ---------------------------------------------------------------------------
async function writeOutput(
  text: string,
  output: string | undefined,
): Promise<void> {
  if (!output || output === "-") {
    // stdout
    const { stdout } = await import("node:process");
    stdout.write(text);
    if (!text.endsWith("\n")) stdout.write("\n");
    return;
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(output, text, "utf8");
}

/**
 * Write binary output (Parquet / Arrow IPC bytes) to stdout or a file. For
 * stdout we write the raw bytes (no trailing newline), since the content is
 * not text.
 */
async function writeBinaryOutput(
  bytes: Uint8Array,
  output: string | undefined,
): Promise<void> {
  if (!output || output === "-") {
    const { stdout } = await import("node:process");
    // process.stdout.write accepts a Buffer (raw bytes, no text encoding).
    stdout.write(Buffer.from(bytes));
    return;
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(output, bytes);
}

// ---------------------------------------------------------------------------
// Optional validation via jsonstat-validator (lazy, peer).
// ---------------------------------------------------------------------------
async function validateDataset(dataset: JsonStatDataset): Promise<string[]> {
  try {
    // jsonstat-validator is an optional peer dependency that may not be
    // installed. Using a non-literal specifier so TypeScript skips static
    // module resolution; the try/catch handles runtime absence.
    const spec = "jsonstat-validator";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ spec);
    const validator =
      mod?.validate ??
      mod?.default?.validate ??
      mod?.default?.default?.validate;
    if (typeof validator !== "function") {
      return ["jsonstat-validator is installed but has no validate() export."];
    }
    const result = validator(dataset);
    return result.valid ? [] : result.errors;
  } catch {
    return [
      "jsonstat-validator is not installed. Install it with: npm i -D jsonstat-validator",
    ];
  }
}

// ---------------------------------------------------------------------------
// Program definition
// ---------------------------------------------------------------------------
const VERSION = "0.1.0";

function createProgram(): Command {
  const program = new Command();

  program
    .name("jsonstat-io")
    .description(
      "Bidirectional bridge between JSON-stat 2.0 and the columnar stack (Arrow, Parquet, DuckDB, Polars, CSVW, CSV).",
    )
    .version(VERSION)
    .argument(
      "[input]",
      'Input file path, URL, or "-" for stdin (default). Supports .parquet, .arrow/.ipc, .csv, .csvw, .json/.jsonstat.',
      "-",
    )
    .option(
      "-f, --from <format>",
      "Source format: auto (default), parquet, arrow, csv, csvw, jsonstat, json",
    )
    .option(
      "-t, --to <format>",
      "Output format: jsonstat (default) = import; arrow, parquet, csv, csvw = export.",
      "jsonstat",
    )
    .option("--measure <column>", "Name of the measure column (overrides detection)")
    .option("--dimensions <a,b,c>", "Comma-separated dimension column names, in order")
    .option(
      "--role <assigns>",
      'Role assignments: time=<col>,geo=<col>,metric=<col> (comma-separated)',
    )
    .option("--status <column>", "Name of the status column")
    .option("--sparse", "Force sparse (object) value form")
    .option("--dense", "Force dense (array) value form")
    .option("--auto", "Auto-detect value form (default)")
    .option("--threshold <n>", "Sparse threshold: null ratio 0–1 (default 0.5)")
    .option(
      "--status-form <form>",
      "Status emission: auto (default), array, string, object, none",
    )
    .option("--label <text>", "Dataset label")
    .option("--source <text>", "Dataset source")
    .option("--updated <date>", "Dataset last-updated date (ISO 8601)")
    .option("--validate", "Validate output with jsonstat-validator (if installed)")
    .option("-o, --output <file>", "Output file path (default: stdout)")
    .option("--pretty", "Pretty-print JSON (default: true)")
    .option("--no-pretty", "Compact JSON output")
    .option("--canonical-keys", "Reorder top-level keys canonically (default: true)")
    .option("--no-canonical-keys", "Preserve source key order")
    .option("--csvw-metadata <json>", "Inline CSVW metadata as a JSON string")
    .option("--delimiter <char>", 'CSV delimiter (default: ",")')
    .action(async (input: string, opts: RawCliOptions) => {
      await run(input, opts);
    });

  return program;
}

// ---------------------------------------------------------------------------
// Core run logic (separated for testability)
// ---------------------------------------------------------------------------

/** Result of a CLI run — exposed for unit tests. */
export interface CliRunResult {
  /** Direction taken: "import" (→ jsonstat) or "export" (→ columnar). */
  direction: "import" | "export";
  /** The input dataset (always JSON-stat). Present for import runs. */
  dataset: JsonStatDataset;
  /** Serialized JSON-stat text (import path only). */
  json?: string;
  /** The export target, when `direction === "export"`. */
  to?: string;
  /** Exported text (csv) or metadata (csvw), when applicable. */
  text?: string;
  /** Exported bytes (parquet / arrow), when applicable. */
  bytes?: Uint8Array;
  /** Validation errors, import path only. */
  validationErrors: string[];
}

/**
 * Run the CLI programmatically. Exposed so tests can invoke the full pipeline
 * without spawning a child process.
 *
 * `--to` drives direction: `jsonstat` (default) = import a columnar source and
 * serialize JSON-stat; `arrow|parquet|csv|csvw` = import a JSON-stat source
 * and export it to the requested columnar format.
 */
export async function run(
  input: string,
  rawOpts: RawCliOptions,
): Promise<CliRunResult> {
  let parsed;
  try {
    parsed = parseCliOptions(rawOpts);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 2;
    throw e;
  }

  const source = input && input !== "-" ? input : "-";

  // --- Export path (--to arrow|parquet|csv|csvw) --------------------------
  // The source must be JSON-stat; we import it as a dataset, then export.
  if (parsed.to !== "jsonstat") {
    return runExport(source, parsed);
  }

  // --- Import path (--to jsonstat) ----------------------------------------
  let dataset: JsonStatDataset;
  try {
    dataset = await importToDataset(source, parsed.importOptions);
  } catch (e) {
    if (e instanceof ImporterError) {
      console.error(`Error: ${e.message}`);
    } else {
      console.error(`Import failed: ${(e as Error).message}`);
    }
    process.exitCode = 1;
    throw e;
  }

  // Optional validation
  let validationErrors: string[] = [];
  if (parsed.validate) {
    validationErrors = await validateDataset(dataset);
    if (validationErrors.length > 0) {
      console.error("Validation failed:");
      for (const err of validationErrors) {
        console.error(`  - ${err}`);
      }
      process.exitCode = 1;
    }
  }

  const json = serialize(dataset, {
    pretty: parsed.pretty,
    canonicalKeys: parsed.canonicalKeys,
  });

  try {
    await writeOutput(json, parsed.output);
  } catch (e) {
    console.error(`Error writing output: ${(e as Error).message}`);
    process.exitCode = 1;
    throw e;
  }

  return { direction: "import", dataset, json, validationErrors };
}

/**
 * Import a JSON-stat source as a dataset, then export it via
 * [`exportDataset`](../index.ts) and write the result. Handles the four
 * `--to` targets: `arrow`, `parquet`, `csv`, `csvw`.
 */
async function runExport(
  source: string,
  parsed: ReturnType<typeof parseCliOptions>,
): Promise<CliRunResult> {
  // Import the JSON-stat source into a dataset first.
  let dataset: JsonStatDataset;
  try {
    // Force the import path to treat the input as JSON-stat.
    dataset = await importToDataset(source, {
      ...parsed.importOptions,
      from: parsed.importOptions.from ?? "jsonstat",
    });
  } catch (e) {
    if (e instanceof ImporterError) {
      console.error(`Error: ${e.message}`);
    } else {
      console.error(`Import failed: ${(e as Error).message}`);
    }
    process.exitCode = 1;
    throw e;
  }

  const to = parsed.to as ExportTarget;
  try {
    const result = await exportDataset(dataset, { to });

    if (to === "csv") {
      const text = result as string;
      await writeOutput(text, parsed.output);
      return { direction: "export", dataset, to, text, validationErrors: [] };
    }
    if (to === "csvw") {
      const { csv, metadata } = result as {
        csv: string;
        metadata: unknown;
      };
      // Write the CSV to -o (or stdout); write the metadata next to it.
      await writeOutput(csv, parsed.output);
      if (parsed.output && parsed.output !== "-") {
        const metaPath = csvwMetadataSibling(parsed.output);
        await writeOutput(
          JSON.stringify(metadata, null, 2),
          metaPath,
        );
      } else {
        // stdout: emit a separator and the metadata for visibility.
        const { stdout } = await import("node:process");
        stdout.write("\n--- metadata.json ---\n");
        stdout.write(JSON.stringify(metadata, null, 2));
        stdout.write("\n");
      }
      return { direction: "export", dataset, to, text: csv, validationErrors: [] };
    }
    if (to === "parquet") {
      const bytes = result as Uint8Array;
      await writeBinaryOutput(bytes, parsed.output);
      return { direction: "export", dataset, to, bytes, validationErrors: [] };
    }
    // arrow → serialize the Table to IPC stream bytes.
    const table = result as Table;
    const bytes = tableToIPC(table, "stream");
    await writeBinaryOutput(new Uint8Array(bytes), parsed.output);
    return { direction: "export", dataset, to, bytes: new Uint8Array(bytes), validationErrors: [] };
  } catch (e) {
    if (e instanceof ImporterError) {
      console.error(`Error: ${e.message}`);
    } else {
      console.error(`Export failed: ${(e as Error).message}`);
    }
    process.exitCode = 1;
    throw e;
  }
}

/** Derive the CSVW metadata sibling path from a CSV output path. */
function csvwMetadataSibling(csvPath: string): string {
  const dot = csvPath.lastIndexOf(".");
  const base = dot > 0 ? csvPath.slice(0, dot) : csvPath;
  return `${base}-metadata.json`;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

// Only run when invoked directly (not when imported by tests).
// ESM-safe: compare the resolved entry path against this module's URL.
const isMain = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  createProgram().parseAsync(process.argv).catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}

export { createProgram };
