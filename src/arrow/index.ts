/**
 * Arrow hub subpath export (`jsonstat-io/arrow`).
 *
 * Re-exports the Arrow ↔ IR converters and the schema-metadata helpers. Import
 * from here to keep the Arrow dependency in a single tree-shakeable chunk,
 * separate from format-specific adapters (parquet/duckdb/polars/csvw).
 */

export {
  arrowToCube,
  arrowToDataset,
  ArrowConversionError,
  type ArrowToCubeOptions,
} from "./arrowToCube";

export { cubeToArrow } from "./arrowFromCube";

export {
  META_PREFIX,
  getFieldMeta,
  getFieldMetaJson,
  getFieldRole,
  isMeasureField,
  isStatusField,
  buildFieldMeta,
  readSchemaMeta,
  buildSchemaMeta,
} from "./schemaMeta";
