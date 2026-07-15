# API Reference

The main entry `jsonstat-io` re-exports the always-loaded layers: model types, core engine, Arrow hub, sink, and isomorphic utils. Format adapters that need optional peers live behind subpath exports. Every subpath is **bidirectional** — it exports both an import function (`xToCube` / `xToDataset`) and an export function (`cubeToX`).

## High-level dispatchers

### `importToCube(source, options?)`

```ts
import { importToCube } from "jsonstat-io";

const obs = await importToCube("./sales.parquet");
```

Loads a source (file path, URL, `"-"` for stdin, `Uint8Array`, or `Blob`), auto-detects the format, and converts it to the [`Observations`](./mapping.md#observations-ir) IR. Dispatches to the right source adapter and funnels through the Arrow hub.

**Parameters:**
- `source: string | Uint8Array | Blob` — the input.
- `options?: ImportOptions` — detection and conversion hints.

**Returns:** `Promise<Observations>`

### `importToDataset(source, options?)`

```ts
import { importToDataset } from "jsonstat-io";

const dataset = await importToDataset("./sales.parquet", {
  measure: "amount",
  roles: { time: ["year"], geo: ["country"] },
  build: { valueForm: "sparse" },
});
```

Like `importToCube` but also builds the final [`JsonStatDataset`](./mapping.md) via `buildDataset`.

**Returns:** `Promise<JsonStatDataset>`

### `ImportOptions`

Extends `ArrowToCubeOptions`:

| Field             | Type                              | Default     | Description |
|-------------------|-----------------------------------|-------------|-------------|
| `from`            | `SourceFormat \| "auto"`          | `"auto"`    | Force a format instead of auto-detecting |
| `build`           | `BuildOptions`                    | —           | Passed to `buildDataset` |
| `csvwMetadata`    | `unknown`                         | —           | CSVW metadata object (when `from: "csvw"`) |
| `datapackageMetadata` | `unknown`                     | —           | Data Package descriptor (when `from: "datapackage"`; otherwise the source bytes *are* the descriptor) |
| `datapackageResourcePath` | `string`                    | —           | Pick the resource whose `path`/`name` matches |
| `datapackageResourceIndex` | `number`                    | —           | Pick the resource by 0-based index |
| `delimiter`       | `string`                          | `","`       | CSV delimiter |
| `decimal`         | `string`                          | —           | Decimal mark override (JSV: overrides the `jsonstat` line) |
| `measure`         | `string`                          | *(detected)*| Measure column name |
| `dimensions`      | `string[]`                        | *(detected)*| Dimension column names |
| `status`          | `string`                          | *(detected)*| Status column name |
| `roles`           | `RoleMap`                         | *(inferred)*| Role assignments |
| `valueForm`       | `"auto" \| "dense" \| "sparse"`  | `"auto"`    | Value form hint |

#### Default-measure rule

When `measure` is not set, the CSV, CSVW, and Data Package adapters look for a
column literally named **`value`** (case-insensitive) and treat it as the
measure. Only if no such column exists do they fall back to type-based inference
(numeric column for CSV/CSVW; first non-`primaryKey` numeric field for Data
Package). Pass an explicit `options.measure` to override this default.

### `importToCube`

Thrown by the dispatchers when a format cannot be detected, a required peer dependency is missing, or the source produces no data.

---

## Export dispatchers

### `exportDataset(dataset, options)`

```ts
import { exportDataset } from "jsonstat-io";

// JSON-stat dataset → Arrow Table
const table = await exportDataset(dataset, { to: "arrow" });

// → Parquet bytes (needs parquet-wasm)
const bytes = await exportDataset(dataset, { to: "parquet" });

// → CSV text
const csv = await exportDataset(dataset, { to: "csv" });

// → CSV-stat (JSV) text — CSV with inline metadata header
const jsv = await exportDataset(dataset, { to: "jsv" });

// → CSV text + CSVW metadata object
const { csv, metadata } = await exportDataset(dataset, { to: "csvw" });

// → CSV text + Frictionless Data Package descriptor
const dp = await exportDataset(dataset, { to: "datapackage" });
```

Flattens a JSON-stat dataset to the Observations IR via `readDataset`, then converts to the requested target format. Arrow-native targets (parquet) funnel through `cubeToArrow`; text targets (csv, jsv, csvw, datapackage) serialize directly from the IR.

**Parameters:**
- `dataset: JsonStatDataset` — the input JSON-stat dataset.
- `options: ExportOptions` — `{ to, ...format-specific options }`.

**Returns:** `Promise<ExportResult>` — an Arrow `Table` (`to: "arrow"`), a `Uint8Array` (`to: "parquet"`), a `string` (`to: "csv"` or `to: "jsv"`), or a `{ csv, metadata }` object (`to: "csvw"` or `to: "datapackage"`).

### `ExportOptions`

| Field    | Type                                | Description |
|----------|-------------------------------------|-------------|
| `to`     | `ExportTarget`                      | `"arrow"` \| `"parquet"` \| `"csv"` \| `"csvw"` \| `"jsv"` \| `"datapackage"` |
| *(format-specific)* | varies                | Passed through to the target adapter (e.g. `compression` for parquet, `delimiter` for csv, `decimal` for jsv) |

---

## Core engine

### `buildDataset(obs, options?)`

```ts
import { buildDataset } from "jsonstat-io";

const { dataset, size, valueForm } = buildDataset(obs, { valueForm: "sparse" });
```

Converts the `Observations` IR into a `JsonStatDataset`. Resolves dimension categories, scatters values into row-major positions, decides dense/sparse, and emits status.

**Returns:** `BuildResult { dataset, size, valueForm }`

### `toDataset(obs)`

Convenience wrapper: `buildDataset(obs).dataset`.

### `readDataset(dataset, options?)`

```ts
import { readDataset } from "jsonstat-io";

const obs = readDataset(jsonStatDataset, { dropNulls: false });
```

The inverse of `buildDataset`: flattens a JSON-stat cube back into the `Observations` IR. Powers round-trip tests, the JSON-stat-as-input path, and **all export** operations (`exportDataset` calls `readDataset` first).

### `BuildOptions`

| Field              | Type                                              | Default | Description |
|--------------------|---------------------------------------------------|---------|-------------|
| `valueForm`        | `"auto" \| "dense" \| "sparse"`                  | `"auto"`| Override value form |
| `sparseThreshold`  | `number`                                          | `0.5`   | Null ratio threshold for auto sparse |
| `statusForm`       | `"auto" \| "array" \| "string" \| "object" \| "none"` | `"auto"`| Status emission form |
| `meta`             | `DatasetMeta`                                     | —       | Dataset label/source/updated |

### Stride utilities

```ts
import { strides, totalCells, flatPosition, multiIndex, enumerateCells } from "jsonstat-io";
```

- `strides(size: number[]): number[]` — stride of each dimension.
- `totalCells(size: number[]): number` — product of all sizes.
- `flatPosition(indices: number[], size: number[]): number` — multi-index → flat position.
- `multiIndex(pos: number, size: number[]): number[]` — flat position → multi-index.
- `enumerateCells(size: number[]): number[][]` — all cell addresses.

---

## Arrow hub

### `arrowToCube(table, options?)`

```ts
import { arrowToCube } from "jsonstat-io";
import { tableFromIPC } from "apache-arrow";

const table = tableFromIPC(bytes);
const obs = arrowToCube(table, { measure: "amount" });
```

Converts an Apache Arrow `Table` to the `Observations` IR. Detects dimensions (dictionary columns), measures (numeric columns), and status from the schema, resolving roles from `jsonstat.*` metadata or heuristics.

### `arrowToDataset(table, options?)`

Async convenience: `buildDataset(arrowToCube(table, options)).dataset`.

### `cubeToArrow(obs)`

The export hub: converts `Observations` IR → Arrow `Table` with dictionary-encoded dimensions and a Float64 measure, annotating fields with `jsonstat.*` metadata. This is what `exportDataset({ to: "arrow" })`, `cubeToParquet`, `cubeToDuckdb`, and `cubeToPolars` all build upon.

### Schema metadata helpers

```ts
import { buildFieldMeta, readSchemaMeta, buildSchemaMeta, getFieldRole } from "jsonstat-io";
```

- `buildFieldMeta(hints)` — construct `Field.metadata` entries from role/label/category hints.
- `readSchemaMeta(schema)` — read `jsonstat.*` schema-level metadata.
- `buildSchemaMeta(hints)` — construct `Schema.metadata` entries.
- `getFieldRole(field)` — extract the role from a field's metadata.

---

## Source adapters (subpath exports)

Each subpath is bidirectional — it exports import (`xToCube` / `xToDataset`) and export (`cubeToX`) functions.

### `jsonstat-io/parquet`

```ts
import { parquetToCube, parquetToDataset, cubeToParquet } from "jsonstat-io/parquet";

const obs = await parquetToCube(bytes, { init: () => parquetWasm.init() });

// Export: IR → Arrow → Parquet bytes
const parquetBytes = await cubeToParquet(obs, { init: () => parquetWasm.init() });
```

Requires `parquet-wasm`. See [`formats/parquet.md`](./formats/parquet.md).

### `jsonstat-io/duckdb`

```ts
import { duckdbToCube, openDuckdbNode, cubeToDuckdb } from "jsonstat-io/duckdb";

const conn = await openDuckdbNode("./data.duckdb");
const obs = await duckdbToCube(conn, "SELECT year, country, amount FROM sales");

// Export: register an Arrow-backed view (or table) in the connection
await cubeToDuckdb(conn, obs, { tableName: "sales", mode: "view" });
```

Requires `duckdb-async` (Node) or `@duckdb/duckdb-wasm` (browser). See [`formats/duckdb.md`](./formats/duckdb.md).

### `jsonstat-io/polars`

```ts
import { polarsToCube, loadPolars, cubeToPolars } from "jsonstat-io/polars";

const pl = await loadPolars();
const df = pl.readCSV("data.csv");
const obs = await polarsToCube(df);

// Export: IR → Arrow → Polars DataFrame
const dfOut = await cubeToPolars(obs);
```

Requires `nodejs-polars`. Node only. See [`formats/polars.md`](./formats/polars.md).

### `jsonstat-io/csvw`

```ts
import { csvwToCube, parseCsvwMetadata, cubeToCsvw } from "jsonstat-io/csvw";

const meta = parseCsvwMetadata(metadataJson);
const obs = csvwToCube(csvText, meta, { dimensions: ["year", "country"] });

// Export: IR → CSV text + CSVW metadata object
const { csv, metadata } = cubeToCsvw(obs);
```

No dependencies. See [`formats/csvw.md`](./formats/csvw.md).

### `jsonstat-io/datapackage`

```ts
import {
  datapackageToCube,
  parseDataPackageMetadata,
  selectResource,
  cubeToDataPackage,
} from "jsonstat-io/datapackage";

const meta = parseDataPackageMetadata(descriptorJson);
const resource = selectResource(meta, { resourcePath: "sales.csv" });
const obs = datapackageToCube(csvText, meta, { measure: "amount" });

// Export: IR → CSV text + Frictionless Data Package descriptor
const { csv, metadata } = cubeToDataPackage(obs);
```

No dependencies. Round-trips JSON-stat semantics via the `jsonstat:*` vendor
extension keys. See [`formats/datapackage.md`](./formats/datapackage.md).

### `jsonstat-io/csv`

```ts
import { csvToCube, cubeToCsv } from "jsonstat-io/csv";

const obs = csvToCube(csvText, { measure: "amount", delimiter: ";" });

// Export: IR → CSV text (dimensions + measure + optional status)
const csv = cubeToCsv(obs);
```

No dependencies. Heuristic measure/dimension inference on import.

### `jsonstat-io/jsv`

```ts
import { csvstatToCube, cubeToCsvstat } from "jsonstat-io/jsv";

const obs = csvstatToCube(jsvText, { decimal: "," });

// Export: IR → CSV-stat (JSV) text
const jsv = cubeToCsvstat(obs);
```

No dependencies. CSV with an inline metadata header (dimensions, roles,
category labels/units, status, dataset `label`/`source`/`updated`/`href`) for
a lossless, single-file round-trip. See [`formats/csv-stat.md`](./formats/csv-stat.md).

---

## Sink

### `serialize(dataset, options?)`

```ts
import { serialize } from "jsonstat-io";

const json = serialize(dataset, { pretty: true, canonicalKeys: true });
```

Produces a canonical JSON string. Optionally reorders top-level keys for diff-stable output.

### `serializeToBytes(dataset, options?)`

Returns `Uint8Array` instead of a string.

---

## Utilities

### Format detection

```ts
import { detectFormat, detectFromBytes, detectFromExtension } from "jsonstat-io";

detectFromBytes(bytes);            // "parquet" | "arrow" | "jsonstat" | "unknown"
detectFromExtension("parquet");    // "parquet"
detectFormat("data.csv", bytes);   // tries extension first, then bytes
```

### Input loading

```ts
import { loadInput } from "jsonstat-io";

const { bytes, source } = await loadInput("./sales.parquet");  // Node: reads file
const { bytes } = await loadInput(blob);                        // Browser: reads Blob
```

### Density decision

```ts
import { decideDensity } from "jsonstat-io";

decideDensity(0.6, 0.5);  // { form: "sparse", nullRatio: 0.6, threshold: 0.5 }
```

---

## Error classes

| Class                 | Thrown by |
|-----------------------|-----------|
| `ImporterError`       | `importToCube`, `importToDataset`, `exportDataset` |
| `ArrowConversionError`| `arrowToCube`, `cubeToArrow` |
| `CubeBuilderError`    | `buildDataset` |
| `CubeReaderError`     | `readDataset` |
| `ParquetSourceError`  | `parquetToCube` |
| `DuckdbSourceError`   | `duckdbToCube` |
| `PolarsSourceError`   | `polarsToCube` |
| `CsvwSourceError`     | `csvwToCube` |
| `CsvSourceError`      | `csvToCube` |
| `CsvStatSourceError`  | `csvstatToCube` |
| `DataPackageSourceError` | `datapackageToCube` |

All extend `Error` and set `this.name` to the class name.
