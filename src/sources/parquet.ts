/**
 * Parquet adapter — `jsonstat-io/parquet`.
 *
 * **Import:** reads a Parquet file (bytes) into an Arrow [`Table`] via
 * `parquet-wasm`, then funnels through the Arrow hub
 * ([`arrowToCube`](../arrow/arrowToCube.ts)).
 *
 * **Export:** [`cubeToParquet`] writes the [`Observations`] IR to a Parquet
 * file via `cubeToArrow` → `parquet-wasm` `writeParquet`.
 *
 * `parquet-wasm` is an **optional peer dependency** — it is imported lazily so
 * that consumers who never touch Parquet pay no bundle cost. If it is not
 * installed, calling [`parquetToCube`] / [`cubeToParquet`] throws a helpful
 * error.
 */

import type { Table } from "apache-arrow";
import { tableFromIPC, tableToIPC } from "apache-arrow";
import { cubeToArrow } from "../arrow/arrowFromCube";
import { type ArrowToCubeOptions, arrowToCube } from "../arrow/arrowToCube";
import type { Observations } from "../model/ir";
import type { JsonStatDataset } from "../model/jsonstat";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ParquetSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParquetSourceError";
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ParquetToCubeOptions extends ArrowToCubeOptions {
  /**
   * Async initializer for parquet-wasm (e.g. to set the WASM base URL in the
   * browser). If provided, it is awaited before reading. Defaults to a no-op.
   */
  init?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal: lazy parquet-wasm loader
// ---------------------------------------------------------------------------

/**
 * Structural shape of the dynamically-imported parquet-wasm module and the WASM
 * objects it returns. parquet-wasm is an **optional peer dependency** with no
 * types imported into this package; its runtime shape also varies across build
 * flavors (ESM/CJS/Node), so we model only the surface we touch.
 */
interface ParquetWasmHandle {
  default?: ParquetWasmHandle;
  init?: () => Promise<void>;
  readParquet?: (bytes: Uint8Array | ArrayBuffer) => ParquetWasmTable;
  writeParquet?: (table: unknown, props?: unknown) => Uint8Array | ArrayBuffer;
  Table?: { fromIPCStream: (ipc: unknown) => unknown };
  Compression?: Record<string, unknown>;
  WriterPropertiesBuilder?: new () => {
    setCompression: (c: unknown) => { build: () => unknown };
  };
}

interface ParquetWasmTable {
  intoIPCStream: () => unknown;
}

/**
 * Dynamically import parquet-wasm and ensure its WASM binary is instantiated.
 * Kept in a function so the import is only evaluated when a Parquet read is
 * actually requested.
 *
 * parquet-wasm's ESM build exports the WASM initializer (`__wbg_init`) as the
 * module's **default** export. Calling it with no argument makes it fetch and
 * instantiate `parquet_wasm_bg.wasm` relative to the module URL. It is
 * idempotent (early-returns once `wasm` is set), so calling it again on a build
 * that already initialized — e.g. the Node/CJS build, which may auto-init — is
 * safe. Without this call, `readParquet`/`writeParquet` throw because the
 * wasm-bindgen internals (e.g. `__wbindgen_add_to_stack_pointer`) are not yet
 * wired up.
 */
async function ensureParquetWasmInit(mod: ParquetWasmHandle): Promise<void> {
  const initialize =
    typeof mod.default === "function"
      ? mod.default // ESM build: default export = __wbg_init
      : typeof mod.init === "function"
        ? mod.init // some bundles expose a named init()
        : undefined;
  if (initialize) await initialize();
}

/**
 * Dynamically import parquet-wasm, ensure the WASM binary is ready, and return
 * the object exposing `readParquet`.
 */
async function loadParquetWasm(): Promise<ParquetWasmHandle> {
  try {
    const mod = (await import("parquet-wasm")) as ParquetWasmHandle;
    await ensureParquetWasmInit(mod);
    // After init, the named exports (readParquet, Table, ...) are ready.
    if (mod.default && typeof mod.default.readParquet === "function") return mod.default;
    return mod;
  } catch {
    throw new ParquetSourceError(
      "parquet-wasm is not installed. Install it with `npm i parquet-wasm` to read Parquet files.",
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a Parquet file (as `Uint8Array` / `ArrayBuffer`) into the
 * [`Observations`] IR.
 *
 * @throws [`ParquetSourceError`] if parquet-wasm is missing or the file is invalid.
 */
export async function parquetToCube(
  bytes: Uint8Array | ArrayBuffer,
  options: ParquetToCubeOptions = {},
): Promise<Observations> {
  if (options.init) await options.init();
  const wasm = await loadParquetWasm();
  let wasmTable: ParquetWasmTable | undefined;
  try {
    // parquet-wasm's readParquet returns its own Arrow Table (apache-arrow
    // interop via IPC), not the caller's apache-arrow Table.
    wasmTable = wasm.readParquet?.(bytes);
  } catch (e: unknown) {
    throw new ParquetSourceError(`Failed to read Parquet: ${errorMessage(e)}`);
  }
  if (!wasmTable) throw new ParquetSourceError("parquet-wasm returned no table");

  // Bridge the dual-Arrow hazard: serialize via IPC (a format both copies
  // understand) and reconstruct with our apache-arrow `tableFromIPC`, exactly
  // as documented in the parquet-wasm README:
  //   const arrowTable = tableFromIPC(wasmTable.intoIPCStream());
  // The IPC bytes come from parquet-wasm's own Arrow copy; apache-arrow's
  // `tableFromIPC` accepts several reader shapes (and a sync/async union), so we
  // widen the unknown view and assert the synchronous Table result.
  const ipc = wasmTable.intoIPCStream();
  const table = tableFromIPC(ipc as Parameters<typeof tableFromIPC>[0]) as Table;
  return arrowToCube(table, options);
}

/** Convenience: Parquet bytes → JSON-stat [`Dataset`]. */
export async function parquetToDataset(
  bytes: Uint8Array | ArrayBuffer,
  options?: ParquetToCubeOptions,
): Promise<JsonStatDataset> {
  const { toDataset } = await import("../core/cubeBuilder");
  return toDataset(await parquetToCube(bytes, options));
}

// ---------------------------------------------------------------------------
// Export: Observations IR → Parquet bytes
// ---------------------------------------------------------------------------

export interface CubeToParquetOptions {
  /**
   * Async initializer for parquet-wasm (e.g. to set the WASM base URL in the
   * browser). If provided, it is awaited before writing. Defaults to a no-op.
   */
  init?: () => Promise<void>;
  /**
   * Compression codec. Falls back to parquet-wasm's default (Snappy) when
   * undefined. Friendly names (case-insensitive) accepted: `"uncompressed"`,
   * `"snappy"`, `"gzip"`, `"brotli"`, `"lz4"`, `"lz4_raw"`, `"zstd"`, `"lzo"`.
   * Codec availability depends on the parquet-wasm build flavor (e.g. Brotli
   * may be absent in slim builds); an unavailable codec surfaces as a
   * [`ParquetSourceError`].
   */
  compression?: string;
}

/**
 * Friendly codec name (lowercase) → parquet-wasm `Compression` enum key.
 *
 * The enum's *numeric* values are read off the loaded wasm module at runtime
 * (see [`buildWriterProperties`]) rather than hardcoded here, so the adapter
 * tracks upstream renumbering automatically. We only map names → enum keys.
 */
const COMPRESSION_CODEC_KEYS = [
  "uncompressed",
  "snappy",
  "gzip",
  "brotli",
  "lz4",
  "lz4_raw",
  "zstd",
  "lzo",
] as const;

/** Set of accepted codec names, for fast lowercase lookup + error messages. */
const COMPRESSION_CODEC_SET = new Set<string>(COMPRESSION_CODEC_KEYS);

/**
 * Build a parquet-wasm `WriterProperties` for the requested codec, or return
 * `undefined` to let `writeParquet` use its default (Snappy).
 *
 * Reads the real `Compression` enum off the loaded wasm module — so we never
 * hardcode numeric values that could drift across parquet-wasm versions.
 *
 * @throws [`ParquetSourceError`] if the codec name is unknown, or if the wasm
 *   build does not export `WriterPropertiesBuilder` / `Compression` / the
 *   requested codec key.
 */
function buildWriterProperties(wasm: ParquetWasmHandle, codec: string | undefined): unknown {
  if (!codec) return undefined;
  const key = codec.toLowerCase();
  if (!COMPRESSION_CODEC_SET.has(key)) {
    throw new ParquetSourceError(
      `Unknown compression codec "${codec}". Valid (case-insensitive): ${[...COMPRESSION_CODEC_KEYS].join(", ")}.`,
    );
  }
  const Compression = wasm.Compression;
  const WriterPropertiesBuilder = wasm.WriterPropertiesBuilder;
  if (!Compression || !WriterPropertiesBuilder) {
    throw new ParquetSourceError(
      `Cannot apply compression "${codec}": this parquet-wasm build does not export WriterPropertiesBuilder/Compression. Omit the \`compression\` option to use the default codec.`,
    );
  }
  const enumKey = key.toUpperCase();
  if (!(enumKey in Compression)) {
    throw new ParquetSourceError(
      `Compression codec "${codec}" is not available in this parquet-wasm build. Omit the \`compression\` option to use the default codec.`,
    );
  }
  return new WriterPropertiesBuilder().setCompression(Compression[enumKey]).build();
}

/**
 * Resolve the parquet-wasm `writeParquet` entrypoint. Mirrors
 * [`loadParquetWasm`], but documented separately because the two bindings can
 * diverge across parquet-wasm versions.
 */
async function loadParquetWriter(): Promise<ParquetWasmHandle> {
  try {
    const mod = (await import("parquet-wasm")) as ParquetWasmHandle;
    await ensureParquetWasmInit(mod);
    if (mod.default && typeof mod.default.writeParquet === "function") return mod.default;
    return mod;
  } catch {
    throw new ParquetSourceError(
      "parquet-wasm is not installed. Install it with `npm i parquet-wasm` to write Parquet files.",
    );
  }
}

/** Extract a human-readable message from a caught value of unknown type. */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Serialize an Arrow [`Table`] to Parquet bytes using `parquet-wasm`. Extracted
 * so [`cubeToParquet`] and the round-trip tests share one path.
 *
 * @internal
 */
export async function arrowToParquet(
  table: Table,
  options: CubeToParquetOptions = {},
): Promise<Uint8Array> {
  if (options.init) await options.init();
  const wasm = await loadParquetWriter();
  try {
    // Resolve the codec to a real parquet-wasm WriterProperties instance.
    // parquet-wasm@0.6.x's writeParquet expects a WriterProperties built via
    // WriterPropertiesBuilder (NOT a plain {compression} options bag); passing
    // a plain object throws "expected instance of WriterProperties". When
    // `compression` is omitted we pass `undefined` so writeParquet falls back
    // to its own default (Snappy). See .idea/jsonstat-io-parquet-compression-plan.md.
    const writerProps = buildWriterProperties(wasm, options.compression);

    // Bridge the dual-Arrow hazard: parquet-wasm bundles its own copy of
    // apache-arrow, so an `instanceof` check against its internal `Table` fails
    // for our caller's `Table`. We serialize via IPC (a format both copies
    // understand) and reconstruct inside parquet-wasm's `Table`, exactly as
    // documented in the parquet-wasm README:
    //   Table.fromIPCStream(tableToIPC(table, "stream"))
    const ipc = tableToIPC(table, "stream");
    const TableNS = wasm.Table;
    if (!TableNS) {
      throw new ParquetSourceError("parquet-wasm build does not expose Table.fromIPCStream.");
    }
    const wasmTable = TableNS.fromIPCStream(ipc);
    const writeParquet = wasm.writeParquet;
    if (!writeParquet) {
      throw new ParquetSourceError("parquet-wasm build does not expose writeParquet.");
    }
    const bytes = writeParquet(wasmTable, writerProps);

    // parquet-wasm returns a Uint8Array (node) or a WebAssembly.Memory-backed
    // view; normalize to Uint8Array in both runtimes.
    if (bytes instanceof Uint8Array) return bytes;
    return new Uint8Array(bytes);
  } catch (e: unknown) {
    throw new ParquetSourceError(`Failed to write Parquet: ${errorMessage(e)}`);
  }
}

/**
 * Write the [`Observations`](../model/ir.ts) IR to a Parquet file (bytes).
 *
 * The IR is first converted to an Arrow [`Table`] via [`cubeToArrow`], then
 * serialized to Parquet via `parquet-wasm`'s `writeParquet`. All `jsonstat.*`
 * schema/field metadata is preserved, so the result round-trips through
 * [`parquetToCube`].
 *
 * @returns A `Uint8Array` of the Parquet file.
 * @throws [`ParquetSourceError`] if parquet-wasm is missing or the write fails.
 *
 * @example
 * ```ts
 * import { cubeToParquet } from "jsonstat-io/parquet";
 * const bytes = await cubeToParquet(observations);
 * ```
 */
export async function cubeToParquet(
  obs: Observations,
  options: CubeToParquetOptions = {},
): Promise<Uint8Array> {
  const table = cubeToArrow(obs);
  return arrowToParquet(table, options);
}
