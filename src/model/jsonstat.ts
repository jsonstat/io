/**
 * JSON-stat 2.0 type model.
 *
 * Faithful TypeScript representation of the JSON-stat 2.0 format, derived from
 * the official specification at https://jsonstat.org/format/ and the official
 * JSON Schemas (raw/schema/{index,dataset,collection,dimension}.json).
 *
 * These are *structural* types: they describe the wire format. Cross-field
 * cube invariants (e.g. `value.length === size.reduce(product)`) live in the
 * core engine, mirroring how the official JSON Schemas defer semantic checks
 * to a separate @jsonstat-validator/ts (not bundled here).
 */

// ---------------------------------------------------------------------------
// Primitives & shared building blocks
// ---------------------------------------------------------------------------

/** Allowed JSON-stat response classes (see the `class` field in the spec). */
export type JsonStatClass = "dataset" | "dimension" | "collection" | "bundle" | "error";

/** Semantic role assigned to one or more dimension IDs (the `role` object). */
export interface JsonStatRole {
  /** Dimension IDs carrying temporal data (chronological order assumed). */
  time?: string[];
  /** Dimension IDs carrying spatial data (categories may have coordinates). */
  geo?: string[];
  /** Dimension IDs carrying different metrics/measures (units attached). */
  metric?: string[];
}

/** Unit of measure metadata for a metric-role category (`category.unit`). */
export interface JsonStatUnit {
  /** Required when `unit` is present: number of decimals. */
  decimals: number;
  /** Unit text displayed after (or before) the value. */
  label?: string;
  /** Unit symbol, e.g. "$" or "%". */
  symbol?: string;
  /** Where the symbol goes relative to the value. Defaults to "end". */
  position?: "start" | "end";
}

/** [longitude, latitude] pair for geo-role categories. */
export type Coordinates = [longitude: number, latitude: number];

/**
 * Category block of a dimension.
 *
 * `index` may be an array (IDs in order) or an object (ID→position map). For
 * constant (single-category) dimensions `index` is unnecessary provided a
 * `label` is given. `label` is optional and falls back to category IDs.
 */
export interface JsonStatCategory {
  /** Category ordering. Array form: `["M","F","T"]`. Object form: `{"M":0,...}`. */
  index?: string[] | Record<string, number>;
  /** ID→human-readable label map. If omitted, IDs are used as labels. */
  label?: Record<string, string>;
  /** Parent ID → array of direct-child IDs (dimension hierarchies). */
  child?: Record<string, string[]>;
  /** ID → [lon, lat] for geo-role categories. */
  coordinates?: Record<string, Coordinates>;
  /** ID → unit metadata for metric-role categories. */
  unit?: Record<string, JsonStatUnit>;
}

/**
 * A dimension object within `dimension`.
 *
 * `category` is the only required property in practice for the dimension
 * class; for dataset-class dimensions it is always present.
 */
export interface JsonStatDimension {
  /** Short descriptive text (lowercase recommended). */
  label?: string;
  /** The categories of this dimension. */
  category?: JsonStatCategory;
  /** URL to an external dimension definition. */
  href?: string;
  /** Provider-specific extension data. */
  extension?: Record<string, unknown>;
  /** Related resources (the `link` array, IANA link relations). */
  link?: JsonStatLink[];
  /** Annotations. */
  note?: string[];
}

// ---------------------------------------------------------------------------
// Links (IANA link relations)
// ---------------------------------------------------------------------------

/** A single link entry. `rel` is an IANA link relation (e.g. "item", "self"). */
export interface JsonStatLink {
  /** IANA link relation type. */
  rel?: string;
  /** Target URL. */
  href?: string;
  /** Type of the linked resource (e.g. a class value). */
  type?: string;
  /** Human-readable label. */
  label?: string;
  /** When present, the item is embedded inline rather than referenced by href. */
  [embedded: string]: unknown;
}

/** Container for links, indexed by relation. The "item" relation holds an array. */
export interface JsonStatLinkMap {
  [rel: string]: JsonStatLink[] | undefined;
}

// ---------------------------------------------------------------------------
// status (observation-level metadata)
// ---------------------------------------------------------------------------

/**
 * Observation-level status. Three forms:
 * - array: one status code per cell (aligned with `value`)
 * - string: a single status applied to all cells
 * - object: position→status for specific cells (sparse status)
 *
 * Status has no standard vocabulary — it is provider-defined.
 */
export type JsonStatStatus = string[] | string | Record<string, string>;

// ---------------------------------------------------------------------------
// value (dense array or sparse object)
// ---------------------------------------------------------------------------

/**
 * Cell values in row-major order ("what does not change, first"; the last
 * dimension in `id` changes fastest).
 *
 * - Array form (dense): missing values are `null`.
 * - Object form (sparse): maps flat position index → value, omitting nulls.
 */
export type JsonStatValue = (number | null)[] | Record<string, number>;

// ---------------------------------------------------------------------------
// Response classes
// ---------------------------------------------------------------------------

/** Top-level dataset response (class = "dataset"). */
export interface JsonStatDataset {
  version: "2.0";
  class: "dataset";
  /** Short descriptive text. */
  label?: string;
  /** Short text describing the dataset source. */
  source?: string;
  /** Update time in ISO 8601. */
  updated?: string;
  /** Ordered list of dimension IDs. */
  id: string[];
  /** Number of categories per dimension, same order as `id`. */
  size: number[];
  /** Per-dimension metadata, keyed by dimension ID. */
  dimension: Record<string, JsonStatDimension>;
  /** Cell values (dense or sparse). */
  value: JsonStatValue;
  /** Observation-level status metadata. */
  status?: JsonStatStatus;
  /** Semantic roles for dimensions. */
  role?: JsonStatRole;
  /** Provider-specific extension data. */
  extension?: Record<string, unknown>;
  /** Related resources. */
  link?: JsonStatLinkMap;
  /** Annotations. */
  note?: string[];
  /** URL of the dataset. */
  href?: string;
  /** Optional error array (suggested, not mandatory). */
  error?: JsonStatError[];
}

/** Dimension-only response. */
export interface JsonStatDimensionResponse {
  version: "2.0";
  class: "dimension";
  label?: string;
  category: JsonStatCategory;
  extension?: Record<string, unknown>;
  link?: JsonStatLinkMap;
  href?: string;
}

/** Collection response (2.0 replacement for bundles). */
export interface JsonStatCollection {
  version: "2.0";
  class: "collection";
  href?: string;
  label?: string;
  updated?: string;
  link: JsonStatLinkMap;
  extension?: Record<string, unknown>;
}

/** A proposed (not mandatory) error entry. */
export interface JsonStatError {
  status?: number;
  id?: string;
  href?: string;
  label?: string;
}

/** Any top-level JSON-stat 2.0 response. */
export type JsonStatResponse = JsonStatDataset | JsonStatDimensionResponse | JsonStatCollection;

/** Discriminated union guard helper: is this a dataset response? */
export function isDataset(r: JsonStatResponse): r is JsonStatDataset {
  return r.class === "dataset";
}

/** Discriminated union guard helper: is this a collection response? */
export function isCollection(r: JsonStatResponse): r is JsonStatCollection {
  return r.class === "collection";
}

/** Discriminated union guard helper: is this a dimension response? */
export function isDimensionResponse(r: JsonStatResponse): r is JsonStatDimensionResponse {
  return r.class === "dimension";
}
