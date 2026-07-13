/**
 * Serialize — turn a JSON-stat [`Dataset`](../model/jsonstat.ts) into a JSON
 * string or Buffer for writing to stdout/file.
 *
 * Also offers a lightweight "pretty" mode that sorts top-level keys in the
 * canonical JSON-stat order (version, class, label, href, source, updated,
 * id, size, dimension, role, value, status, …) so output is stable and
 * diff-friendly — useful for fixtures and round-trip tests.
 */

import type { JsonStatDataset, JsonStatResponse } from "../model/jsonstat";

// Canonical top-level key order for pretty output.
const KEY_ORDER = [
  "version",
  "class",
  "label",
  "href",
  "source",
  "updated",
  "id",
  "size",
  "dimension",
  "role",
  "value",
  "status",
  "extension",
  "link",
  "note",
  "error",
];

export interface SerializeOptions {
  /** Pretty-print with 2-space indentation (default true). */
  pretty?: boolean;
  /** Reorder top-level keys canonically (default true, only with pretty). */
  canonicalKeys?: boolean;
}

/**
 * Serialize a JSON-stat response to a JSON string.
 *
 * @param response The dataset (or any JSON-stat response).
 */
export function serialize(
  response: JsonStatResponse | JsonStatDataset,
  options: SerializeOptions = {},
): string {
  const pretty = options.pretty ?? true;
  const canonical = options.canonicalKeys ?? true;

  let value: unknown = response;
  if (pretty && canonical) {
    value = reorderKeys(response as object, KEY_ORDER);
  }

  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/**
 * Serialize and encode as UTF-8 bytes (Uint8Array). Handy for file writing
 * without pulling in Node's Buffer in browser contexts.
 */
export function serializeToBytes(
  response: JsonStatResponse | JsonStatDataset,
  options?: SerializeOptions,
): Uint8Array {
  return new TextEncoder().encode(serialize(response, options));
}

/**
 * Reorder an object's keys so that known keys appear in `order`, and any
 * unknown keys follow alphabetically. Only reshuffles top-level keys (does not
 * recurse), to avoid disturbing category/index ordering.
 */
function reorderKeys(obj: object, order: string[]): Record<string, unknown> {
  const source = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const known = new Set<string>();
  for (const k of order) {
    if (k in source) {
      out[k] = source[k];
      known.add(k);
    }
  }
  const rest = Object.keys(source)
    .filter((k) => !known.has(k))
    .sort();
  for (const k of rest) out[k] = source[k];
  return out;
}
