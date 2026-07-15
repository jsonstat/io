# Architecture

This document explains the layered design of `jsonstat-io` and the rationale behind the two key decisions: the **Arrow hub** and the **Observations IR**. Both import (columnar → JSON-stat) and export (JSON-stat → columnar) are fully supported and share the same IR.

## The core problem

JSON-stat 2.0 is a *dense or sparse* multidimensional cube model: values are laid out in **row-major order** ("what does not change first") across the cross-product of dimension categories. Every statistical office, every data portal, and increasingly every lakehouse produces *tabular* data instead — Parquet, Arrow, CSV, DataFrames. These two worlds speak different shapes:

| JSON-stat cube        | Columnar / tabular      |
|-----------------------|-------------------------|
| N-dimensional array   | 2D table (rows × cols)  |
| Row-major value order | Columnar or row order   |
| Dimensions × size     | Column names × values   |
| Implicit cell address | Explicit row            |

`jsonstat-io` bridges this gap in both directions. The challenge is not just *reading* a format — it's **faithfully reconstructing the full JSON-stat model** (roles, labels, units, coordinates, hierarchies, status, sparse/dense) from a source that carries only raw values unless you annotate it, and reversing that reconstruction losslessly on export.

## The Arrow-hub insight

Apache Arrow is the *de facto* in-memory standard of the columnar data stack. Critically, the major lakehouse engines all emit Arrow tables natively:

- **Parquet** → Arrow via `parquet-wasm` (or DuckDB/Polars, which read Parquet)
- **DuckDB** → Arrow via `.arrow()` / `.arrowResult()`
- **Polars** → Arrow via `toArrow()` / `toIPC()`
- **Arrow IPC** → Arrow via `tableFromIPC()` (it already *is* Arrow)

This means a single converter pair — `arrowToCube` (import) and `cubeToArrow` (export) — handles four of the five major formats in both directions. Adding a new Arrow-native source is a ~30-line adapter that calls `arrowToCube` on import and `cubeToArrow` on export. The mapping logic (dimension detection, role resolution, value scattering, status emission) lives in exactly one place per direction and is tested once.

```
 IMPORT
 N sources ──▶ Arrow Table ──▶ arrowToCube ──▶ Observations IR ──▶ buildDataset ──▶ JSON-stat
              (one shape)      (one converter)  (one IR)            (one builder)    (one format)

 EXPORT
 JSON-stat ──▶ readDataset ──▶ Observations IR ──▶ cubeToArrow ──▶ Arrow Table ──▶ N targets
                               (one IR)           (one converter)  (one shape)
```

CSVW and plain CSV do not produce Arrow natively in this package, so they build the IR directly on import and serialize from the IR directly on export — but they share the *same* IR type and the *same* builder/reader, so the downstream path is identical.

## Layered architecture

The package is organized in strict layers with one-way dependencies:

```
┌─────────────────────────────────────────────────────────┐
│  Public API (index.ts) + CLI (cli/)                     │  ← what consumers call
├─────────────────────────────────────────────────────────┤
│  Sources (parquet, duckdb, polars, csvw, csv,           │  ← format adapters
│           datapackage) + Browser shims (browser/)       │
├─────────────────────────────────────────────────────────┤
│  Arrow hub (arrowToCube, arrowFromCube, schemaMeta)     │  ← the hub
├─────────────────────────────────────────────────────────┤
│  Core engine (strides, cubeBuilder, cubeReader)         │  ← the math
├─────────────────────────────────────────────────────────┤
│  Model (jsonstat types, Observations IR)                │  ← pure types
├─────────────────────────────────────────────────────────┤
│  Sink (serialize) + Utils (detect, fetch, density)      │  ← isomorphic helpers
└─────────────────────────────────────────────────────────┘
```

Each layer depends only on the layers below it. The model layer is pure TypeScript types with zero runtime cost. The core engine is pure logic with no I/O. The Arrow hub depends on `apache-arrow` (a hard dependency). Source adapters depend on optional peers, imported lazily.

### Layer 1: Model (`src/model/`)

Two parallel type definitions:

- **`jsonstat.ts`** — the JSON-stat 2.0 wire types: `JsonStatDataset`, `JsonStatDimension`, `JsonStatCategory`, `JsonStatRole`, `JsonStatUnit`, etc. Plus type guards (`isDataset`, `isCollection`).
- **`ir.ts`** — the internal `Observations` IR: a tidy long table with `DimensionColumn[]`, one `MeasureColumn`, an optional `StatusColumn`, a `RoleMap`, `DatasetMeta`, and a `valueForm` hint.

No runtime logic here except `observationCount()`. This is the contract every layer agrees on.

### Layer 2: Core engine (`src/core/`)

The mathematical heart:

- **`strides.ts`** — row-major stride arithmetic. `strides(size)` computes the stride of each dimension; `flatPosition(indices, size)` maps a multi-index to a flat array position; `multiIndex` is the inverse; `enumerateCells` iterates all cell addresses.
- **`cubeBuilder.ts`** — `buildDataset(obs, options)` resolves dimension categories (explicit order or first-seen), scatters the measure values into their row-major positions, decides dense vs sparse, and emits status. This is the "long → wide" pivot.
- **`cubeReader.ts`** — `readDataset(dataset)` is the inverse: it takes a JSON-stat cube and *flattens* it back into the Observations IR. This powers round-trip tests and the JSON-stat-as-input path.

The core has **zero I/O dependencies** — it operates on plain arrays and objects. This is what makes it isomorphic and testable.

### Layer 3: Arrow hub (`src/arrow/`)

- **`schemaMeta.ts`** — defines the `jsonstat.*` metadata key contract on Arrow `Field` and `Schema` objects. This is how producers annotate Arrow tables with JSON-stat semantics (roles, labels, units, coordinates, hierarchies). Without metadata, `arrowToCube` falls back to heuristics.
- **`arrowToCube.ts`** — `arrowToCube(table, options)` reads an Arrow `Table`, detects dimensions (dictionary columns), measures (numeric columns), and status, resolves roles from metadata + options, and produces the `Observations` IR. This is the single converter that Parquet/DuckDB/Polars all funnel through.
- **`arrowFromCube.ts`** — `cubeToArrow(obs)` is the Phase 2 seam: IR → Arrow Table. It builds dictionary-encoded dimension columns and a Float64 measure column, annotating fields with `jsonstat.*` metadata for lossless round-trips.

### Layer 4: Source adapters (`src/sources/`)

Each adapter is bidirectional — a thin wrapper that, on import, gets bytes (or a live connection/DataFrame) into an Arrow Table then calls `arrowToCube`, and on export, takes the Arrow Table (or IR) from `cubeToArrow` and writes it to the target format:

- **`parquet.ts`** — `parquetToCube(bytes)` / `cubeToParquet(obs)` via `parquet-wasm` (lazy import). Browser + Node.
- **`duckdb.ts`** — `duckdbToCube(conn, query)` / `cubeToDuckdb(conn, obs)` runs SQL on import, registers an Arrow view/table on export. Supports `duckdb-async` (Node) and `@duckdb/duckdb-wasm` (browser).
- **`polars.ts`** — `polarsToCube(df)` / `cubeToPolars(obs)` via `toArrow()`/`fromArrow()`. Node only.
- **`csvw.ts`** — `csvwToCube(text, metadata)` / `cubeToCsvw(obs)` uses CSVW metadata for lossless mapping. No deps.
- **`csv.ts`** — `csvToCube(text)` / `cubeToCsv(obs)` infers measure/dimensions heuristically on import; serializes dimensions+measure+status columns on export. No deps.
- **`csvstat.ts`** — `csvstatToCube(text)` / `cubeToCsvstat(obs)` handles the CSV-stat (JSV) format: CSV with an inline metadata header that round-trips dimensions, roles, category labels/units, status and dataset `label`/`source`/`updated`/`href`. No deps. See [`formats/csv-stat.md`](./formats/csv-stat.md).
- **`datapackage.ts`** — `datapackageToCube(text, descriptor)` / `cubeToDataPackage(obs)` maps a Frictionless Data Package schema (`fields`/`primaryKey`/`type`/`rdfType`) and round-trips JSON-stat semantics via the `jsonstat:*` vendor extension keys. No deps.

All optional peer imports are **lazy** (`await import(...)`) so they never enter a bundle that doesn't use them.

### Layer 4b: Browser shims (`src/browser/`)

Used only by the standalone IIFE bundle (`tsup`'s `browserConfig`), not by the
library build:

- **`arrow-global.ts`** — reads `globalThis.Arrow` (the apache-arrow UMD global
  loaded via a separate `<script>` tag) and re-exports the named symbols the
  package needs. This is what enables the *two-tag* browser pattern: one tag for
  apache-arrow, one for the slim jsonstat-io IIFE.
- **`peer-stub.ts`** — a `Proxy` that throws on any access, aliased to the
  optional heavy peers (`parquet-wasm`, `@duckdb/duckdb-wasm`, `duckdb-async`,
  `nodejs-polars`) at build time. Because IIFE cannot code-split, the dynamic
  imports of these peers would otherwise inline megabytes of WASM; the stub
  keeps the bundle ~17 KB gzipped while preserving a friendly error path (the
  adapters' lazy loaders already wrap these in try/catch).

See the README *"Browser / CDN"* section for the usage pattern.

### Layer 5: Sink + Utils (`src/sink/`, `src/util/`)

- **`serialize.ts`** — `serialize(dataset, options)` produces canonical JSON. Optionally reorders top-level keys for diff-stable output. `serializeToBytes` returns `Uint8Array`.
- **`detect.ts`** — `detectFormat(source, bytes)` sniffs the format from magic bytes (Parquet `PAR1`, Arrow `ARROW1`) and file extension. Used by the high-level dispatchers.
- **`fetch.ts`** — `loadInput(source)` normalizes file paths, URLs, stdin, `Uint8Array`, and `Blob` into a uniform `LoadedInput { bytes, source }`. Uses `fetch` in the browser, `node:fs` in Node.
- **`density.ts`** — `decideDensity(nullRatio, threshold)` implements the sparse/dense auto-decision.

## The Observations IR

The `Observations` IR is the keystone. It is a **tidy long table**:

```ts
interface Observations {
  dimensions: Record<string, DimensionColumn>;  // { values: string[] }
  measure:  MeasureColumn;                       // { values: (number|null)[] }
  status?:  StatusColumn;                        // { values: string[] }
  roles?:   RoleMap;                             // { time?: string[], geo?: string[], metric?: string[] }
  meta?:    DatasetMeta;                         // { label?, source?, updated? }
  valueForm?: "auto" | "dense" | "sparse";
}
```

Every source produces this shape. `buildDataset` is the only consumer that pivots it into the row-major cube. This separation means:

1. **Adding a source** = producing `Observations`. You never touch the cube math.
2. **Testing the cube math** = construct `Observations` directly, no file I/O.
3. **Round-tripping** = `readDataset` (cube → IR) + `buildDataset` (IR → cube).

## Bidirectional scope

Both directions are fully implemented and tested:

- **Import** (columnar → JSON-stat): `arrowToCube` handles Arrow-native sources; `csvToCube` / `csvwToCube` / `csvstatToCube` / `datapackageToCube` handle text formats; `buildDataset` scatters into the cube. Exposed via [`importToDataset`](./api.md#importtodatasetsource-options).
- **Export** (JSON-stat → columnar): `readDataset` flattens the cube to the IR; `cubeToArrow` handles Arrow-native targets (Parquet, DuckDB, Polars); `cubeToCsv` / `cubeToCsvw` / `cubeToCsvstat` / `cubeToDataPackage` handle text targets. Exposed via [`exportDataset`](./api.md#exportdatasetdataset-options).
- **CLI:** the `--to` flag drives direction — `jsonstat` (default) imports; `arrow|parquet|csv|csvw|jsv|datapackage` exports.

The same Observations IR sits at the center of both directions, guaranteeing that `export → import` round-trips losslessly.

## The Rust/Wasm accelerator seam

The performance-critical path is `buildDataset`'s value scattering and `cubeToArrow`'s vector building — the nested-loop stride multiplication. The public API signatures (`buildDataset`, `arrowToCube`, `cubeToArrow`, `exportDataset`) are stable and framework-agnostic. An accelerator can replace the internals behind the same types, yielding a drop-in speedup with no consumer changes.
