# jsonstat-io

> Convert between [JSON-stat 2.0](https://jsonstat.org/) cubes and the columnar stack — Apache Arrow, Parquet, DuckDB, Polars, CSVW, CSV. An Arrow-bridged, bidirectional interop layer for the lakehouse ecosystem.

`jsonstat-io` bridges the **columnar stack** — Arrow, Parquet, DuckDB, Polars — and the **JSON-stat statistical format** in a single, dependency-light package. Because Parquet, DuckDB, and Polars all emit Apache Arrow tables natively, one conversion path serves them all in **both directions**:

- **Import:** columnar → JSON-stat (`importToDataset`)
- **Export:** JSON-stat → columnar (`exportDataset`)

This is the *Arrow-hub* insight: **N sources → one Arrow hub → JSON-stat**, and back. The same `arrowToCube` / `cubeToArrow` pair powers every binary format.

- **Bidirectional.** Import and export are both first-class, fully-tested directions sharing one round-trip-safe IR.
- **Pure-TS core.** The cube engine is pure TypeScript, with a documented seam to swap in a Rust/Wasm accelerator later without changing the public API.
- **Isomorphic.** Works in Node (≥18) and the browser. Heavy format engines (Parquet/DuckDB/Polars) are optional peer dependencies, imported lazily so browser bundles stay lean.

## Install

```sh
npm install jsonstat-io
```

The only hard runtime dependencies are [`apache-arrow`](https://arrow.apache.org/docs/js/) and [`commander`](https://github.com/tj/commander.js) (CLI only). Format-specific engines are **optional peers** — install only what you use:

```sh
npm install parquet-wasm         # Parquet (browser + Node)
npm install duckdb-async         # DuckDB (Node)
npm install @duckdb/duckdb-wasm  # DuckDB (browser)
npm install nodejs-polars        # Polars (Node only)
npm install jsonstat-validator   # optional output validation
```

## Quick start

### Import — columnar → JSON-stat (Node or browser)

```ts
import { importToDataset } from "jsonstat-io";

// Auto-detects Parquet from magic bytes → Arrow hub → JSON-stat dataset.
const dataset = await importToDataset("./sales.parquet");
console.log(JSON.stringify(dataset, null, 2));
```

One call handles files, URLs, stdin (`"-"`), `Uint8Array`, and `Blob`:

```ts
await importToDataset("https://example.com/data.arrow");    // URL
await importToDataset(bytes);                                // Uint8Array
await importToDataset("./report.csv", { from: "csv" });      // force CSV
```

### Export — JSON-stat → columnar (Node or browser)

```ts
import { exportDataset } from "jsonstat-io";

// JSON-stat dataset → Arrow Table
const table = await exportDataset(dataset, { to: "arrow" });

// → Parquet bytes (needs parquet-wasm)
const parquetBytes = await exportDataset(dataset, { to: "parquet" });

// → CSV text + CSVW metadata
const { csv, metadata } = await exportDataset(dataset, { to: "csvw" });
```

### CLI

The `--to` flag drives direction: `jsonstat` (default) imports; `arrow|parquet|csv|csvw` exports.

```sh
# IMPORT: file → JSON-stat, written to stdout
npx jsonstat-io ./sales.parquet

# Write to a file, with a dataset label
npx jsonstat-io ./sales.parquet -o sales.jsonstat.json --label "Sales 2024"

# Pipe CSV on stdin, assign roles explicitly
cat data.csv | npx jsonstat-io - --measure amount --role time=year,geo=country

# EXPORT: JSON-stat → Parquet
npx jsonstat-io ./sales.jsonstat.json --to parquet -o sales.parquet

# JSON-stat → CSV (+ sibling -metadata.json)
npx jsonstat-io ./sales.jsonstat.json --to csv -o sales.csv
```

See [`docs/cli.md`](./docs/cli.md) for the full CLI reference.

## Why Arrow as the hub?

| Format   | Arrow-native? | Import adapter                       | Export adapter                       |
|----------|:-------------:|--------------------------------------|--------------------------------------|
| Parquet  | ✅ `parquet-wasm` | [`/parquet`](./docs/formats/parquet.md) | [`/parquet`](./docs/formats/parquet.md) |
| DuckDB   | ✅ `.arrow()`     | [`/duckdb`](./docs/formats/duckdb.md)  | [`/duckdb`](./docs/formats/duckdb.md)  |
| Polars   | ✅ `toArrow()`    | [`/polars`](./docs/formats/polars.md)  | [`/polars`](./docs/formats/polars.md)  |
| Arrow IPC| ✅ (it *is* Arrow)| [`/arrow`](./docs/formats/arrow.md)    | [`/arrow`](./docs/formats/arrow.md)    |
| CSVW     | ❌ → IR directly  | [`/csvw`](./docs/formats/csvw.md)      | [`/csvw`](./docs/formats/csvw.md)      |
| Plain CSV| ❌ → IR directly  | [`/csv`](./docs/formats/csv.md)        | [`/csv`](./docs/formats/csv.md)        |

Every Arrow-producing format funnels through **one** `arrowToCube` / `cubeToArrow` pair. This means the JSON-stat mapping logic (dimensions, roles, sparse/dense, status) is implemented and tested exactly once per direction, then reused. Adding a new Arrow-native format is a ~30-line adapter.

## How it works

```
IMPORT (columnar → JSON-stat)
┌──────────┐   ┌─────────────┐   ┌──────────┐   ┌──────────────┐
│ Parquet  │──▶│ parquet-wasm│──▶│          │   │              │
│ DuckDB   │──▶│ .arrow()    │──▶│ Arrow    │──▶│ arrowToCube  │──┐
│ Polars   │──▶│ toArrow()   │──▶│ Table    │   │ (the hub)    │  │
│ Arrow IPC│──▶│ tableFromIPC│──▶│          │   │              │  │
└──────────┘   └─────────────┘   └──────────┘   └──────────────┘  │
                                                                   ▼
┌──────────┐   ┌─────────────┐                          ┌────────────────┐
│ CSVW     │──▶│ csvwToCube  │─────────────────────────▶│ Observations   │
│ CSV      │──▶│ csvToCube   │─────────────────────────▶│ IR (tidy long) │
│ JSON-stat│──▶│ readDataset │─────────────────────────▶│ (round-trip)   │
└──────────┘   └─────────────┘                          └───────┬────────┘
                                                                 │ buildDataset
                                                                 ▼
                                                         ┌───────────────┐
                                                         │ JSON-stat 2.0 │
                                                         │ Dataset       │
                                                         └───────────────┘

EXPORT (JSON-stat → columnar)
   JSON-stat Dataset ──▶ readDataset ──▶ Observations IR ──┬─▶ cubeToArrow ──▶ Arrow / Parquet / DuckDB / Polars
                                                          ├─▶ cubeToCsv   ──▶ CSV text
                                                          └─▶ cubeToCsvw  ──▶ CSV + CSVW metadata
```

The central intermediate representation is the **Observations IR** ([`Observations`](./src/model/ir.ts)): a tidy long table with dimension columns, exactly one measure column, and an optional status column. Every source produces it; [`buildDataset`](./src/core/cubeBuilder.ts) scatters it into the row-major JSON-stat cube, and [`readDataset`](./src/core/cubeReader.ts) flattens a cube back into the IR for export.

## Architecture at a glance

```
src/
├── model/          # Pure types: JSON-stat + Observations IR (zero runtime)
├── core/           # The engine: strides math, cube builder, cube reader
│   ├── strides.ts      # Row-major stride arithmetic (flatPosition, multiIndex)
│   ├── cubeBuilder.ts  # Observations IR → JSON-stat Dataset (import)
│   └── cubeReader.ts   # JSON-stat Dataset → Observations IR (export)
├── arrow/          # The Arrow hub (bidirectional)
│   ├── schemaMeta.ts   # jsonstat.* metadata key contract
│   ├── arrowToCube.ts  # Arrow Table → Observations IR (import)
│   └── arrowFromCube.ts# Observations IR → Arrow Table (export)
├── sources/        # Per-format adapters (optional peers, lazy, bidirectional)
│   ├── parquet.ts  duckdb.ts  polars.ts  csvw.ts  csv.ts
├── sink/           # serialize.ts — JSON-stat → canonical JSON string/bytes
├── util/           # detect.ts (format sniffing), fetch.ts (loading), density.ts
├── cli/            # args.ts (parsing) + index.ts (commander entry)
└── index.ts        # Public API barrel + importToDataset / exportDataset
```

See [`docs/architecture.md`](./docs/architecture.md) for the layered design rationale, [`docs/mapping.md`](./docs/mapping.md) for the spec-fidelity mapping table, and [`docs/api.md`](./docs/api.md) for the full API reference.

## Spec fidelity

`jsonstat-io` preserves the full JSON-stat 2.0 model, not just values, in both directions:

- **Roles** (`time`, `geo`, `metric`) — from Arrow schema metadata or explicit options.
- **Category labels, units, coordinates, child hierarchies** — round-tripped via `jsonstat.*` metadata keys.
- **Dense vs sparse value forms** — auto-decided by null ratio, or forced via options.
- **Status** (string / array / object forms) — emitted per-row, deduplicated when uniform.
- **Canonical key ordering** — the serializer reorders top-level keys to the canonical order for diff-stable output.

See [`docs/mapping.md`](./docs/mapping.md) for the complete fidelity table.

## Node vs Browser

| Capability              | Node ≥18 | Browser |
|-------------------------|:--------:|:-------:|
| Arrow IPC               | ✅       | ✅      |
| Parquet (`parquet-wasm`)| ✅       | ✅      |
| DuckDB (wasm)           | ✅       | ✅      |
| DuckDB (native)         | ✅       | —       |
| Polars                  | ✅       | —       |
| CSVW / CSV              | ✅       | ✅      |
| CLI                     | ✅       | —       |
| File paths / stdin      | ✅       | —       |

In the browser, pass `Uint8Array` or `Blob` directly; the library never touches `node:fs`.

## Documented seams

1. **Rust/Wasm accelerator:** The pure-TS stride math and value scattering in `core/` is the performance-critical path. The public API (`buildDataset`, `arrowToCube`, `exportDataset`) is stable; an accelerator can replace the internals behind the same signatures.

## Testing

159 tests cover the stride math, cube builder/reader, Arrow hub round-trips, JSON-stat round-trips, export round-trips (Arrow, CSV, CSVW, Parquet), format detection, density decisions, serialization, and CLI argument parsing:

```sh
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # tsup (ESM + CJS + .d.ts)
```

## License

Apache-2.0 © Xavier Badosa
