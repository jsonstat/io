/**
 * Isomorphic input loader — works in both Node and the browser.
 *
 * Resolves a source specifier (file path, URL, or raw bytes/text) into a
 * `Uint8Array` of bytes and, where possible, a hint about its origin (path/URL)
 * so format detection can use the extension.
 *
 * - **Node**: reads from `node:fs` for local paths; uses `fetch` for URLs and
 *   for the browser. Reading from stdin is supported via the special source
 *   `"-"`.
 * - **Browser**: uses the global `fetch` for URLs and `File`/`Blob` inputs;
 *   local paths are not available.
 *
 * The Node-specific `fs`/`stdin` imports are guarded by a runtime check so the
 * same code path works in browsers without bundling `node:fs`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoadedInput {
  bytes: Uint8Array;
  /** The original source path/URL, if known (used for extension detection). */
  source?: string;
  /** True if the source was stdin ("-"). */
  fromStdin?: boolean;
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

function isNode(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.versions !== "undefined" &&
    typeof process.versions.node === "string"
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load input bytes from a path, URL, `"-"` (stdin), `Uint8Array`, `Blob`, or
 * string.
 *
 * @param source A file path, `http(s)://` URL, `"-"` for stdin, or raw data.
 * @throws If the source cannot be read.
 */
export async function loadInput(source: string | Uint8Array | Blob): Promise<LoadedInput> {
  // Already bytes.
  if (source instanceof Uint8Array) {
    return { bytes: source };
  }
  // Blob / File (browser & undici).
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    const buf = await source.arrayBuffer();
    return { bytes: new Uint8Array(buf), source: (source as File).name };
  }
  if (typeof source !== "string") {
    throw new TypeError(`loadInput: unsupported source type ${typeof source}`);
  }

  // stdin.
  if (source === "-") {
    if (!isNode()) {
      throw new Error('loadInput: stdin ("-") is only supported in Node');
    }
    const bytes = await readStdin();
    return { bytes, fromStdin: true };
  }

  // URL.
  if (/^https?:\/\//i.test(source) || /^file:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`loadInput: fetch ${source} failed: ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    return { bytes: new Uint8Array(buf), source };
  }

  // Local file path (Node only).
  if (isNode()) {
    const bytes = await readFileNode(source);
    return { bytes, source };
  }

  throw new Error(`loadInput: cannot resolve "${source}" in a browser without a URL scheme`);
}

// ---------------------------------------------------------------------------
// Node helpers (lazy imports)
// ---------------------------------------------------------------------------

async function readStdin(): Promise<Uint8Array> {
  // Use process.stdin directly — avoids the PathLike type mismatch that
  // createReadStream(0) triggers under @types/node, and is more idiomatic.
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function readFileNode(path: string): Promise<Uint8Array> {
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
