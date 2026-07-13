/**
 * Arrow schema metadata contract for JSON-stat.
 *
 * Producers (Parquet/DuckDB/Polars/CSVW adapters, or hand-built Arrow tables)
 * annotate Arrow [`Field`](https://arrow.apache.org/docs/js/) metadata with
 * `jsonstat.*` keys so that [`arrowToCube`](./arrowToCube.ts) can reconstruct
 * the full JSON-stat model — not just the raw values. Without these keys the
 * converter falls back to heuristic inference (dictionary columns = dimensions,
 * first numeric column = measure); with them, the mapping is exact and
 * lossless, which is what the round-trip tests require.
 *
 * ## Metadata key reference
 *
 * Field-level keys (on `Field.metadata`):
 *
 * | Key                          | Value                                  | Meaning |
 * |------------------------------|----------------------------------------|---------|
 * | `jsonstat.role`              | `"time"` / `"geo"` / `"metric"`        | Dimension role |
 * | `jsonstat.measure`           | `"true"`                               | Marks this column as the measure (overrides type heuristics) |
 * | `jsonstat.status`            | `"true"`                               | Marks this column as the per-row status column |
 * | `jsonstat.label`             | string                                 | Dimension label |
 * | `jsonstat.categoryLabels`    | JSON object: `{id: label}`             | Category labels |
 * | `jsonstat.categoryUnits`     | JSON object: `{id: {decimals,...}}`    | Per-category unit metadata (metric role) |
 * | `jsonstat.categoryCoords`    | JSON object: `{id: [lon,lat]}`         | Per-category coordinates (geo role) |
 * | `jsonstat.categoryChild`     | JSON object: `{parent: [child,...]}`   | Hierarchy |
 * | `jsonstat.categoryOrder`     | JSON array: `[id,...]`                 | Explicit category ordering (e.g. chronological) |
 *
 * Schema-level keys (on `Schema.metadata`):
 *
 * | Key                          | Value                                  | Meaning |
 * |------------------------------|----------------------------------------|---------|
 * | `jsonstat.label`             | string                                 | Dataset label |
 * | `jsonstat.source`            | string                                 | Dataset source |
 * | `jsonstat.updated`           | ISO 8601 string                        | Dataset update time |
 * | `jsonstat.extension`         | JSON object                            | Provider extension data |
 * | `jsonstat.valueForm`         | `"auto"`/`"dense"`/`"sparse"`          | Value emission hint |
 *
 * See [docs/mapping.md](../../docs/mapping.md) for the full fidelity table.
 */

import type { Field, Schema } from "apache-arrow";
import type {
  DatasetMeta,
  RoleMap,
} from "../model/ir";
import type { JsonStatRole } from "../model/jsonstat";

/** Metadata namespace prefix used for all JSON-stat keys. */
export const META_PREFIX = "jsonstat.";

// ---------------------------------------------------------------------------
// Field metadata: reading
// ---------------------------------------------------------------------------

/** Read a single string metadata value from a field. */
export function getFieldMeta(field: Field, key: string): string | undefined {
  return field.metadata.get(`${META_PREFIX}${key}`);
}

/** Read and JSON-parse a field metadata value, with a fallback. */
export function getFieldMetaJson<T>(field: Field, key: string): T | undefined {
  const raw = getFieldMeta(field, key);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Is this field marked as the measure column? */
export function isMeasureField(field: Field): boolean {
  return getFieldMeta(field, "measure") === "true";
}

/** Is this field marked as the status column? */
export function isStatusField(field: Field): boolean {
  return getFieldMeta(field, "status") === "true";
}

/** Read the dimension role assigned to a field, if any. */
export function getFieldRole(field: Field): "time" | "geo" | "metric" | undefined {
  const r = getFieldMeta(field, "role");
  if (r === "time" || r === "geo" || r === "metric") return r;
  return undefined;
}

// ---------------------------------------------------------------------------
// Field metadata: writing
// ---------------------------------------------------------------------------

/** Build a metadata Map for a field from JSON-stat-oriented hints. */
export function buildFieldMeta(hints: {
  role?: "time" | "geo" | "metric";
  measure?: boolean;
  status?: boolean;
  label?: string;
  categoryLabels?: Record<string, string>;
  categoryUnits?: Record<string, unknown>;
  categoryCoords?: Record<string, [number, number]>;
  categoryChild?: Record<string, string[]>;
  categoryOrder?: string[];
}): Map<string, string> {
  const meta = new Map<string, string>();
  if (hints.role) meta.set(`${META_PREFIX}role`, hints.role);
  if (hints.measure) meta.set(`${META_PREFIX}measure`, "true");
  if (hints.status) meta.set(`${META_PREFIX}status`, "true");
  if (hints.label) meta.set(`${META_PREFIX}label`, hints.label);
  if (hints.categoryLabels)
    meta.set(`${META_PREFIX}categoryLabels`, JSON.stringify(hints.categoryLabels));
  if (hints.categoryUnits)
    meta.set(`${META_PREFIX}categoryUnits`, JSON.stringify(hints.categoryUnits));
  if (hints.categoryCoords)
    meta.set(`${META_PREFIX}categoryCoords`, JSON.stringify(hints.categoryCoords));
  if (hints.categoryChild)
    meta.set(`${META_PREFIX}categoryChild`, JSON.stringify(hints.categoryChild));
  if (hints.categoryOrder)
    meta.set(`${META_PREFIX}categoryOrder`, JSON.stringify(hints.categoryOrder));
  return meta;
}

// ---------------------------------------------------------------------------
// Schema metadata: reading
// ---------------------------------------------------------------------------

/** Read dataset-level metadata from a schema. */
export function readSchemaMeta(schema: Schema): {
  meta?: DatasetMeta;
  roles?: RoleMap;
  valueForm?: "auto" | "dense" | "sparse";
} {
  const meta: DatasetMeta = {};
  const label = schema.metadata.get(`${META_PREFIX}label`);
  const source = schema.metadata.get(`${META_PREFIX}source`);
  const updated = schema.metadata.get(`${META_PREFIX}updated`);
  const extensionRaw = schema.metadata.get(`${META_PREFIX}extension`);
  const valueForm = schema.metadata.get(`${META_PREFIX}valueForm`);
  if (label) meta.label = label;
  if (source) meta.source = source;
  if (updated) meta.updated = updated;
  if (extensionRaw) {
    try {
      meta.extension = JSON.parse(extensionRaw) as Record<string, unknown>;
    } catch {
      /* ignore malformed extension */
    }
  }

  // Roles are also expressible at the schema level as a single JSON object
  // (useful when a producer wants to declare roles without per-field metadata).
  let roles: RoleMap | undefined;
  const rolesRaw = schema.metadata.get(`${META_PREFIX}roles`);
  if (rolesRaw) {
    try {
      roles = JSON.parse(rolesRaw) as JsonStatRole;
    } catch {
      /* ignore */
    }
  }

  return {
    meta: Object.keys(meta).length ? meta : undefined,
    roles,
    valueForm:
      valueForm === "auto" || valueForm === "dense" || valueForm === "sparse"
        ? valueForm
        : undefined,
  };
}

/** Build a schema-level metadata Map from dataset hints. */
export function buildSchemaMeta(hints: {
  label?: string;
  source?: string;
  updated?: string;
  extension?: Record<string, unknown>;
  roles?: RoleMap;
  valueForm?: "auto" | "dense" | "sparse";
}): Map<string, string> {
  const meta = new Map<string, string>();
  if (hints.label) meta.set(`${META_PREFIX}label`, hints.label);
  if (hints.source) meta.set(`${META_PREFIX}source`, hints.source);
  if (hints.updated) meta.set(`${META_PREFIX}updated`, hints.updated);
  if (hints.extension)
    meta.set(`${META_PREFIX}extension`, JSON.stringify(hints.extension));
  if (hints.roles) meta.set(`${META_PREFIX}roles`, JSON.stringify(hints.roles));
  if (hints.valueForm) meta.set(`${META_PREFIX}valueForm`, hints.valueForm);
  return meta;
}
