/**
 * Format detection — sniffs the input source to pick the right adapter.
 *
 * Two signals are used, in order of reliability:
 *  1. **Magic bytes** (content sniffing) — authoritative for binary formats
 *     (Parquet `PAR1`, Arrow IPC `ARROW1`).
 *  2. **File extension** — used when content is not yet available (e.g. a path
 *     or URL) or for text formats (`.csv`, `.csvw`).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SourceFormat =
  | "parquet"
  | "arrow"
  | "csv"
  | "csvw"
  | "jsonstat"
  | "json"
  | "unknown";

// ---------------------------------------------------------------------------
// Magic bytes
// ---------------------------------------------------------------------------

/** Parquet files begin with `PAR1`. */
const PARQUET_MAGIC = [0x50, 0x41, 0x52, 0x31]; // "PAR1"
/** Arrow IPC files begin with `ARROW1\0\0`. */
const ARROW_MAGIC = [0x41, 0x52, 0x52, 0x4f, 0x57, 0x31]; // "ARROW1"

function bytesStartWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * Sniff the format from the leading bytes of a binary/text input.
 *
 * @returns The detected format, or "unknown" if no magic matches.
 */
export function detectFromBytes(bytes: Uint8Array | ArrayBuffer): SourceFormat {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (bytesStartWith(view, PARQUET_MAGIC)) return "parquet";
  if (bytesStartWith(view, ARROW_MAGIC)) return "arrow";
  // JSON-stat / JSON text: starts with `{` (after optional BOM/whitespace).
  const head = view.slice(0, Math.min(64, view.length));
  const text = new TextDecoder().decode(head).trimStart();
  if (text.startsWith("{") || text.startsWith("[")) {
    // Heuristic: if it mentions "json-stat" or `"class"` + `"version"`, JSON-stat.
    if (text.includes("json-stat") || (text.includes('"class"') && text.includes('"version"'))) {
      return "jsonstat";
    }
    return "json";
  }
  // CSV: presence of a delimiter and typical header-ish content is weak; defer
  // to extension if available. Mark as "csv" only as a fallback guess.
  if (text.includes(",") || text.includes(";") || text.includes("\t")) return "csv";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Map a file extension (without dot) to a source format. */
export function detectFromExtension(ext: string): SourceFormat {
  const e = ext.toLowerCase().replace(/^\./, "");
  switch (e) {
    case "parquet":
      return "parquet";
    case "arrow":
    case "ipc":
    case "feather":
      return "arrow";
    case "csv":
      return "csv";
    case "csvw":
    case "csv-metadata":
      return "csvw";
    case "json-stat":
    case "jsonstat":
      return "jsonstat";
    case "json":
      return "jsonstat"; // assume JSON-stat by default for .json
    default:
      return "unknown";
  }
}

/** Extract the extension from a path/URL (without the dot), or undefined. */
export function extensionOf(path: string): string | undefined {
  // Strip query string / fragment.
  const clean = path.split("?")[0]?.split("#")[0] ?? path;
  const dot = clean.lastIndexOf(".");
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (dot === -1 || dot < slash) return undefined;
  return clean.slice(dot + 1);
}

/**
 * Detect a format from a filename/URL, falling back to bytes if the extension
 * is unknown or ambiguous.
 */
export function detectFormat(
  pathOrUrl: string | undefined,
  bytes?: Uint8Array | ArrayBuffer,
): SourceFormat {
  if (pathOrUrl) {
    const ext = extensionOf(pathOrUrl);
    if (ext) {
      const byExt = detectFromExtension(ext);
      if (byExt !== "unknown") return byExt;
    }
  }
  if (bytes) return detectFromBytes(bytes);
  return "unknown";
}
