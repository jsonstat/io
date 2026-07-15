/**
 * jsonstat-io — public API surface (main entry).
 *
 * This package is a **bidirectional** bridge between JSON-stat 2.0 and the
 * columnar stack (Arrow, Parquet, DuckDB, Polars, CSVW, CSV):
 *
 * - **Import** (columnar → JSON-stat): [`importToCube`](#importtocube) /
 *   [`importToDataset`](#importtodataset) — load, auto-detect, convert, build.
 * - **Export** (JSON-stat → columnar): [`exportDataset`](#exportdataset) — read
 *   the JSON-stat cube into the IR and route to the requested sink writer.
 *
 * This barrel re-exports the **always loaded** layers: the model types, the
 * core cube engine (strides, builder, reader), the Arrow hub, the sink, and the
 * isomorphic utilities (format detection, input loading, density decision).
 *
 * Source/sink adapters that pull in optional peer dependencies live behind
 * **subpath exports** so that browser bundles stay lean and tree-shakeable:
 *
 * - `jsonstat-io/arrow`  — Arrow hub (re-exported here too, since
 *   `apache-arrow` is a hard dependency, not an optional peer).
 * - `jsonstat-io/parquet` — Parquet ↔ Arrow ↔ cube (needs `parquet-wasm`).
 * - `jsonstat-io/duckdb`  — DuckDB ↔ Arrow ↔ cube (needs duckdb).
 * - `jsonstat-io/polars`  — Polars ↔ Arrow ↔ cube (Node-only).
 * - `jsonstat-io/csvw`    — CSVW + CSV metadata-aware path (no deps).
 * - `jsonstat-io/csv`     — plain CSV inference path (no deps).
 *
 * For a one-call convenience, see the dispatchers:
 * - Import: [`importToCube`](#importtocube) / [`importToDataset`](#importtodataset).
 * - Export: [`exportDataset`](#exportdataset).
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Model layer (pure types + guards, zero runtime cost)
// ---------------------------------------------------------------------------
export type {
  JsonStatClass,
  JsonStatRole,
  JsonStatUnit,
  Coordinates,
  JsonStatCategory,
  JsonStatDimension,
  JsonStatLink,
  JsonStatLinkMap,
  JsonStatStatus,
  JsonStatValue,
  JsonStatDataset,
  JsonStatDimensionResponse,
  JsonStatCollection,
  JsonStatError,
  JsonStatResponse,
} from "./model/jsonstat";
export { isDataset, isCollection, isDimensionResponse } from "./model/jsonstat";

export type {
  DimensionColumn,
  MeasureColumn,
  StatusColumn,
  RoleMap,
  DatasetMeta,
  CubeModel,
  Observations,
} from "./model/ir";
export { observationCount } from "./model/ir";

// ---------------------------------------------------------------------------
// Core engine (strides, builder, reader)
// ---------------------------------------------------------------------------
export {
  strides,
  totalCells,
  flatPosition,
  multiIndex,
  enumerateCells,
} from "./core/strides";

export { CubeBuilderError } from "./core/cubeBuilder";
export type { BuildOptions, BuildResult } from "./core/cubeBuilder";
export { buildDataset, toDataset } from "./core/cubeBuilder";

export { CubeReaderError } from "./core/cubeReader";
export type { ReadOptions } from "./core/cubeReader";
export { readDataset, readResponse } from "./core/cubeReader";

// ---------------------------------------------------------------------------
// Arrow hub (hard dependency, so safe to re-export from the main entry)
// ---------------------------------------------------------------------------
export {
  META_PREFIX,
  getFieldMeta,
  getFieldMetaJson,
  isMeasureField,
  isStatusField,
  getFieldRole,
  buildFieldMeta,
  readSchemaMeta,
  buildSchemaMeta,
} from "./arrow/schemaMeta";

export { ArrowConversionError } from "./arrow/arrowToCube";
export type { ArrowToCubeOptions } from "./arrow/arrowToCube";
export { arrowToCube, arrowToDataset } from "./arrow/arrowToCube";

export { cubeToArrow } from "./arrow/arrowFromCube";

// ---------------------------------------------------------------------------
// Sink (serialization)
// ---------------------------------------------------------------------------
export type { SerializeOptions } from "./sink/serialize";
export { serialize, serializeToBytes } from "./sink/serialize";

// ---------------------------------------------------------------------------
// Isomorphic utilities
// ---------------------------------------------------------------------------
export type { SourceFormat } from "./util/detect";
export {
  detectFromBytes,
  detectFromExtension,
  extensionOf,
  detectFormat,
} from "./util/detect";

export type { DensityResult, DensityOptions } from "./util/density";
export { decideDensity } from "./util/density";

export type { LoadedInput } from "./util/fetch";
export { loadInput } from "./util/fetch";

// ---------------------------------------------------------------------------
// High-level convenience: load → detect → convert → build
// ---------------------------------------------------------------------------

import { tableFromIPC } from "apache-arrow";
import type { Table } from "apache-arrow";
import { cubeToArrow } from "./arrow/arrowFromCube";
import { arrowToCube } from "./arrow/arrowToCube";
import type { ArrowToCubeOptions } from "./arrow/arrowToCube";
import { buildDataset } from "./core/cubeBuilder";
import type { BuildOptions, BuildResult } from "./core/cubeBuilder";
import type { Observations } from "./model/ir";
import type { JsonStatDataset } from "./model/jsonstat";
import type { CsvwMetadata } from "./sources/csvw";
import type { DataPackageMetadata } from "./sources/datapackage";
import { detectFormat, detectFromBytes } from "./util/detect";
import type { SourceFormat } from "./util/detect";
import { loadInput } from "./util/fetch";
import type { LoadedInput } from "./util/fetch";

/**
 * Options for the high-level [`importToCube`](#importtocube) /
 * [`importToDataset`](#importtodataset) dispatchers.
 *
 * These combine format detection, source loading, and Arrow-hub conversion
 * hints into a single call.
 */
export interface ImportOptions extends ArrowToCubeOptions {
  /**
   * Force a source format instead of auto-detecting. One of `"parquet"`,
   * `"arrow"`, `"csv"`, `"csvw"`, `"jsv"`, `"datapackage"`, `"jsonstat"`,
   * `"json"`. When omitted the format is sniffed from magic bytes (Parquet
   * `PAR1`, Arrow IPC `ARROW1`, CSV-stat `jsonstat,`) and then from the file
   * extension.
   */
  from?: SourceFormat | "auto";
  /** Passed through to [`buildDataset`](./core/cubeBuilder.ts) as `BuildOptions`. */
  build?: BuildOptions;
  /**
   * CSVW metadata, when the source is CSVW. If `from === "csvw"` and this is
   * omitted, the dispatcher attempts to load a sibling `*-metadata.json` next
   * to the CSV path (Node only). In the browser the caller must supply it.
   */
  csvwMetadata?: unknown;
  /**
   * Data Package descriptor, when the source is a Data Package. Two modes:
   *
   * - **Omitted** (default): the *source* is the `datapackage.json` descriptor
   *   itself. The dispatcher parses it, resolves the resource's CSV `path`
   *   relative to the descriptor location (Node or URL), loads it, and reads.
   *   Resources with inline `data` need no CSV.
   * - **Provided**: the *source* is the CSV body and this option carries the
   *   descriptor (mirrors the CSVW `csvwMetadata` convention).
   */
  datapackageMetadata?: unknown;
  /**
   * Select a specific resource by its `path` in a multi-resource package
   * (Data Package only). Defaults to the first resource.
   */
  datapackageResourcePath?: string;
  /**
   * Select a specific resource by zero-based index in a multi-resource package
   * (Data Package only). Defaults to `0` (the first resource).
   */
  datapackageResourceIndex?: number;
  /**
   * CSV delimiter (default `,`). Used for plain CSV, CSVW and CSV-stat (JSV).
   */
  delimiter?: string;
  /**
   * CSV-stat (JSV) decimal delimiter override. By default it is read from the
   * `jsonstat` line's first content column (falling back to `.`).
   */
  decimal?: string;
}

/**
 * Error thrown by the high-level dispatchers when a format cannot be detected,
 * a required peer dependency is missing, or the source produces no data.
 */
export class ImporterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImporterError";
  }
}

/**
 * Load a columnar source (file path, URL, stdin `"-"`, `Uint8Array`, or `Blob`)
 * and convert it to the [`Observations`](./model/ir.ts) IR.
 *
 * This is the one-call convenience that ties together
 * [`loadInput`](./util/fetch.ts), [`detectFormat`](./util/detect.ts), the
 * appropriate source adapter, and the Arrow hub. It auto-detects the format
 * unless [`options.from`](#ImportOptions.from) is set.
 *
 * Parquet/DuckDB/Polars adapters are imported lazily, so they are only pulled
 * into the bundle when actually needed.
 *
 * @param source A file path, `http(s)://` URL, `"-"` for stdin (Node),
 *   `Uint8Array`, or `Blob`.
 * @returns The [`Observations`](./model/ir.ts) IR, ready for
 *   [`buildDataset`](./core/cubeBuilder.ts).
 *
 * @example
 * ```ts
 * import { importToDataset } from "jsonstat-io";
 * const dataset = await importToDataset("./sales.parquet");
 * console.log(JSON.stringify(dataset, null, 2));
 * ```
 */
export async function importToCube(
  source: string | Uint8Array | Blob,
  options: ImportOptions = {},
): Promise<Observations> {
  const loaded: LoadedInput = await loadInput(source);

  // --- Resolve the format -------------------------------------------------
  let format: SourceFormat;
  if (options.from && options.from !== "auto") {
    format = options.from;
  } else if (loaded.source) {
    format = detectFormat(loaded.source, loaded.bytes);
  } else {
    format = detectFromBytes(loaded.bytes);
  }

  // --- Dispatch to the right adapter --------------------------------------
  switch (format) {
    case "arrow": {
      const table = tableFromIPC(loaded.bytes);
      return arrowToCube(table, options);
    }

    case "parquet": {
      // Lazy import keeps parquet-wasm out of browser bundles that don't use it.
      const { parquetToCube } = await import("./sources/parquet");
      return parquetToCube(loaded.bytes, options);
    }

    case "csv": {
      const { csvToCube } = await import("./sources/csv");
      const text = new TextDecoder().decode(loaded.bytes);
      return csvToCube(text, {
        measure: options.measure,
        dimensions: options.dimensions,
        status: options.status,
        roles: options.roles,
        delimiter: options.delimiter,
      });
    }

    case "jsv": {
      const { csvstatToCube } = await import("./sources/csvstat");
      const text = new TextDecoder().decode(loaded.bytes);
      return csvstatToCube(text, {
        delimiter: options.delimiter,
        decimal: options.decimal,
      });
    }

    case "csvw": {
      const { csvwToCube, parseCsvwMetadata } = await import("./sources/csvw");
      const text = new TextDecoder().decode(loaded.bytes);
      let metadata: CsvwMetadata | undefined;
      if (options.csvwMetadata !== undefined) {
        // Validate caller-supplied metadata through the same parser.
        metadata = parseCsvwMetadata(options.csvwMetadata);
      } else if (loaded.source) {
        // Try a sibling *-metadata.json (common CSVW convention), Node only.
        try {
          const metaPath = siblingMetadataPath(loaded.source);
          const metaBytes = await loadInput(metaPath);
          metadata = parseCsvwMetadata(JSON.parse(new TextDecoder().decode(metaBytes.bytes)));
        } catch {
          throw new ImporterError(
            `CSVW metadata not supplied and could not be auto-loaded next to "${loaded.source}". Pass options.csvwMetadata or set options.from = "csv".`,
          );
        }
      }
      if (metadata === undefined) {
        throw new ImporterError("CSVW source requires metadata. Pass options.csvwMetadata.");
      }
      return csvwToCube(text, metadata, {
        measure: options.measure,
        dimensions: options.dimensions,
        status: options.status,
        roles: options.roles,
      });
    }

    case "datapackage": {
      const { datapackageToCube, parseDataPackageMetadata, selectResource } = await import(
        "./sources/datapackage"
      );
      let metadata: DataPackageMetadata;
      let csvText: string | undefined;
      if (options.datapackageMetadata !== undefined) {
        // Caller supplied the descriptor; loaded bytes are the CSV body.
        metadata = parseDataPackageMetadata(options.datapackageMetadata);
        csvText = new TextDecoder().decode(loaded.bytes);
      } else {
        // Loaded bytes ARE the descriptor (the datapackage.json convention).
        metadata = parseDataPackageMetadata(JSON.parse(new TextDecoder().decode(loaded.bytes)));
      }
      const resourceOpts = {
        resourcePath: options.datapackageResourcePath,
        resourceIndex: options.datapackageResourceIndex,
      };
      const adapterOpts = {
        measure: options.measure,
        dimensions: options.dimensions,
        status: options.status,
        roles: options.roles,
        ...resourceOpts,
        delimiter: options.delimiter,
      };
      // Inline data needs no CSV load.
      const resource = selectResource(metadata, resourceOpts);
      if (!(resource.data && resource.data.length > 0)) {
        if (csvText === undefined) {
          if (!resource.path) {
            throw new ImporterError(
              "Data Package resource has no `path` and no inline `data`. " +
                "Pass options.datapackageMetadata (with the CSV as the source) " +
                "or ensure the resource declares a `path`.",
            );
          }
          if (!loaded.source) {
            throw new ImporterError(
              "Cannot resolve the resource's relative `path` without a " +
                "descriptor source path. Pass the datapackage.json path/URL " +
                "as the source, or supply the CSV as the source with " +
                "options.datapackageMetadata.",
            );
          }
          const csvPath = resolveSibling(loaded.source, resource.path);
          const csvBytes = await loadInput(csvPath);
          csvText = new TextDecoder().decode(csvBytes.bytes);
        }
      }
      return datapackageToCube(csvText ?? "", metadata, adapterOpts);
    }

    case "jsonstat":
    case "json": {
      // A JSON-stat input: read it back into the IR via the cube reader.
      // This supports the round-trip / re-emission use case.
      const { readDataset } = await import("./core/cubeReader");
      const parsed = JSON.parse(new TextDecoder().decode(loaded.bytes));
      return readDataset(parsed, { dropNulls: false });
    }

    default:
      throw new ImporterError(
        `Could not detect the source format. Set options.from explicitly (e.g. "parquet", "arrow", "csv", "csvw", "jsonstat"). DuckDB and Polars require a live connection/DataFrame — use the dedicated subpath import (e.g. import { duckdbToCube } from "jsonstat-io/duckdb").`,
      );
  }
}

/**
 * Like [`importToCube`](#importtocube) but also builds the final
 * [`JsonStatDataset`](./model/jsonstat.ts) via [`buildDataset`](./core/cubeBuilder.ts).
 *
 * @returns The serialized-ready [`JsonStatDataset`](./model/jsonstat.ts).
 */
export async function importToDataset(
  source: string | Uint8Array | Blob,
  options: ImportOptions = {},
): Promise<JsonStatDataset> {
  const obs = await importToCube(source, options);
  const result: BuildResult = buildDataset(obs, options.build);
  return result.dataset;
}

/**
 * Build the conventional sibling metadata path for a CSVW CSV file.
 * `data/sales.csv` → `data/sales-metadata.json`.
 */
function siblingMetadataPath(csvPath: string): string {
  const dot = csvPath.lastIndexOf(".");
  const base = dot > 0 ? csvPath.slice(0, dot) : csvPath;
  return `${base}-metadata.json`;
}

/**
 * Resolve a relative resource path against a descriptor base (file path or URL).
 *
 * Used by the Data Package import path to locate the CSV a resource points at:
 * `data/datapackage.json` + `sales.csv` → `data/sales.csv`.
 */
function resolveSibling(basePath: string, relative: string): string {
  if (/^https?:\/\//i.test(basePath)) {
    try {
      return new URL(relative, basePath).href;
    } catch {
      // Fall through to the string manipulation below.
    }
  }
  const slash = basePath.lastIndexOf("/");
  const dir = slash >= 0 ? basePath.slice(0, slash + 1) : "";
  return dir + relative;
}

// ---------------------------------------------------------------------------
// High-level convenience: JSON-stat → columnar (export / Phase 2)
// ---------------------------------------------------------------------------

/** Supported export sinks for [`exportDataset`](#exportdataset). */
export type ExportTarget = "arrow" | "parquet" | "csv" | "csvw" | "jsv" | "datapackage";

/**
 * Options for [`exportDataset`](#exportdataset).
 *
 * Format-specific knobs are passed through to the underlying writer. For
 * Parquet, `init` is forwarded to `parquet-wasm`; for CSVW, `url` sets the
 * metadata `url`. DuckDB and Polars are intentionally not exposed here because
 * they require a live connection / native module — use the dedicated subpath
 * exports (`jsonstat-io/duckdb`, `jsonstat-io/polars`) for those.
 */
export interface ExportOptions {
  to: ExportTarget;
  /** Parquet compression codec (forwarded to `parquet-wasm` `writeParquet`). */
  compression?: string;
  /** CSV / CSVW delimiter (default ","). */
  delimiter?: string;
  /** CSVW metadata `url` field. */
  url?: string;
  /** Line terminator for CSV / CSVW / CSV-stat / Data Package output (default "\r\n"). */
  lineTerminator?: string;
  /** CSV-stat (JSV) decimal delimiter written to the `jsonstat` line (default "."). */
  decimal?: string;
  /** CSV-stat (JSV) unit separator written to the `jsonstat` line (default "|"). */
  unitSep?: string;
  /**
   * Data Package resource `path` (the CSV file the descriptor references).
   * Defaults to `"data.csv"`. Data Package export only.
   */
  datapackagePath?: string;
  /**
   * Data Package `name` slug. Defaults to a slug of the dataset label.
   * Data Package export only.
   */
  datapackageName?: string;
  /** Async initializer for parquet-wasm (browser base URL, etc.). */
  init?: () => Promise<void>;
}

/**
 * The polymorphic result of [`exportDataset`](#exportdataset). The concrete
 * shape depends on [`ExportOptions.to`](#ExportOptions.to):
 *
 * - `"arrow"` → an Apache Arrow [`Table`](https://arrow.apache.org/docs/js/).
 * - `"parquet"` → a `Uint8Array` of the Parquet file bytes.
 * - `"csv"` → the CSV text (`string`).
 * - `"csvw"` → `{ csv: string; metadata: CsvwMetadata }`.
 * - `"jsv"` → the CSV-stat (JSV) text (`string`).
 * - `"datapackage"` → `{ csv: string; metadata: DataPackageMetadata }`.
 */
export type ExportResult = Table | Uint8Array | string | CsvwExportShape | DataPackageExportShape;

/** Shape of the `"csvw"` export result (mirrors `csvw.CsvwExport`). */
export interface CsvwExportShape {
  csv: string;
  metadata: unknown;
}

/** Shape of the `"datapackage"` export result. */
export interface DataPackageExportShape {
  csv: string;
  metadata: unknown;
}

/**
 * Export a JSON-stat [`Dataset`](./model/jsonstat.ts) to a columnar format.
 *
 * This is the high-level export dispatcher, the mirror of
 * [`importToDataset`](#importtodataset). It reads the dataset into the
 * [`Observations`](./model/ir.ts) IR via [`readDataset`](./core/cubeReader.ts),
 * then routes to the appropriate writer:
 *
 * - `"arrow"`  → [`cubeToArrow`](./arrow/arrowFromCube.ts) → Arrow `Table`.
 * - `"parquet"` → Arrow → `parquet-wasm` `writeParquet` → `Uint8Array`.
 * - `"csv"`    → [`cubeToCsv`](./sources/csv.ts) → CSV text.
 * - `"csvw"`   → [`cubeToCsvw`](./sources/csvw.ts) → `{ csv, metadata }`.
 * - `"datapackage"` → [`cubeToDataPackage`](./sources/datapackage.ts) → `{ csv, metadata }`.
 *
 * DuckDB and Polars require a live connection / native module and are not
 * reachable from this dispatcher — use the dedicated subpath writers
 * (`cubeToDuckdb`, `cubeToPolars`) directly.
 *
 * @example
 * ```ts
 * import { exportDataset } from "jsonstat-io";
 * const bytes = await exportDataset(dataset, { to: "parquet" });
 * ```
 */
export async function exportDataset(
  dataset: JsonStatDataset,
  options: ExportOptions,
): Promise<ExportResult> {
  // Lazy import keeps the reader out of the import-only bundle path.
  const { readDataset } = await import("./core/cubeReader");
  const obs = readDataset(dataset, { dropNulls: false });

  switch (options.to) {
    case "arrow": {
      return cubeToArrow(obs);
    }
    case "parquet": {
      const { cubeToParquet } = await import("./sources/parquet");
      return cubeToParquet(obs, {
        init: options.init,
        compression: options.compression,
      });
    }
    case "csv": {
      const { cubeToCsv } = await import("./sources/csv");
      return cubeToCsv(obs, {
        delimiter: options.delimiter,
        lineTerminator: options.lineTerminator,
      });
    }
    case "csvw": {
      const { cubeToCsvw } = await import("./sources/csvw");
      return cubeToCsvw(obs, {
        delimiter: options.delimiter,
        lineTerminator: options.lineTerminator,
        url: options.url,
      });
    }
    case "jsv": {
      const { cubeToCsvstat } = await import("./sources/csvstat");
      return cubeToCsvstat(obs, {
        delimiter: options.delimiter,
        decimal: options.decimal,
        unitSep: options.unitSep,
        lineTerminator: options.lineTerminator,
      });
    }
    case "datapackage": {
      const { cubeToDataPackage } = await import("./sources/datapackage");
      return cubeToDataPackage(obs, {
        delimiter: options.delimiter,
        lineTerminator: options.lineTerminator,
        path: options.datapackagePath,
        name: options.datapackageName,
      });
    }
    default:
      throw new ImporterError(
        `Unsupported export target "${(options as { to?: string }).to}". Use one of: "arrow", "parquet", "csv", "csvw", "jsv", "datapackage". For DuckDB/Polars, use the dedicated subpath writers.`,
      );
  }
}
