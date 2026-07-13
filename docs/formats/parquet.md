# Parquet Format

Parquet files are read via [`parquet-wasm`](https://github.com/kylebarron/parquet-wasm), which decodes Parquet into an Apache Arrow table — then the [Arrow hub](./arrow.md) takes over. On export, the same Arrow table is written back to Parquet bytes via `parquet-wasm`'s `writeParquet`.

## Install

```sh
npm install jsonstat-io parquet-wasm
```

`parquet-wasm` is an **optional peer dependency**. It works in both Node and the browser.

## Import path

```ts
import { parquetToCube, parquetToDataset } from "jsonstat-io/parquet";
```

Or use the high-level dispatcher (auto-detects Parquet from `PAR1` magic bytes):

```ts
import { importToDataset } from "jsonstat-io";
const dataset = await importToDataset("./sales.parquet");
```

## Node example

```ts
import { readFileSync } from "node:fs";
import { parquetToDataset } from "jsonstat-io/parquet";

const bytes = readFileSync("./sales.parquet");
const dataset = await parquetToDataset(bytes, {
  measure: "amount",
  roles: { time: ["year"], geo: ["country"] },
});
```

## Browser example

`parquet-wasm` needs its WASM binary loaded. Pass an `init` function to set the base URL or call `parquetWasm.init()`:

```ts
import { parquetToDataset } from "jsonstat-io/parquet";

async function initParquet() {
  const wasm = await import("parquet-wasm");
  if (typeof wasm.init === "function") await wasm.init();
}

const bytes = new Uint8Array(await (await fetch("/sales.parquet")).arrayBuffer());
const dataset = await parquetToDataset(bytes, { init: initParquet });
```

## Export path

[`cubeToParquet`](../../src/sources/parquet.ts) converts the `Observations` IR to Parquet bytes: it calls `cubeToArrow` to build the Arrow table, then `parquet-wasm`'s `writeParquet` to serialize.

```ts
import { exportDataset } from "jsonstat-io";

// JSON-stat → Parquet bytes
const bytes = await exportDataset(dataset, {
  to: "parquet",
  init: () => parquetWasm.init(),
});
```

Or use `cubeToParquet` directly on the IR:

```ts
import { cubeToParquet } from "jsonstat-io/parquet";

const bytes = await cubeToParquet(obs, {
  init: () => parquetWasm.init(),
  compression: "snappy",
});
```

### CLI

```sh
# JSON-stat → Parquet
npx jsonstat-io ./sales.jsonstat.json --to parquet -o sales.parquet
```

## Import CLI

```sh
npx jsonstat-io ./sales.parquet -o sales.jsonstat.json
npx jsonstat-io ./sales.parquet --from parquet --sparse
```

The CLI auto-detects Parquet from the `PAR1` magic bytes, so `--from parquet` is optional.

## Options

### `ParquetToCubeOptions` (import)

Extends [`ArrowToCubeOptions`](./arrow.md):

| Field     | Type           | Description |
|-----------|----------------|-------------|
| `init`    | `() => Promise<void>` | Async initializer for parquet-wasm (e.g. to set the WASM base URL in the browser). Awaited before reading. |
| `measure` | `string`       | Measure column name |
| `dimensions` | `string[]`   | Dimension column names |
| `roles`   | `RoleMap`      | Role assignments |

### `CubeToParquetOptions` (export)

| Field        | Type           | Description |
|--------------|----------------|-------------|
| `init`       | `() => Promise<void>` | Async initializer for parquet-wasm. |
| `compression`| `string`       | Parquet compression codec (e.g. `"snappy"`, `"gzip"`). |

## How it works

> **Dual-Arrow IPC bridge:** `parquet-wasm` bundles its own copy of `apache-arrow`, so an `instanceof Table` check against its internal `Table` class fails for our caller's `Table` (and vice versa). The adapter bridges this with IPC serialization — a format both copies understand:

**Import:**
1. `parquetToCube` lazily imports `parquet-wasm`.
2. Calls `wasm.readParquet(bytes)` → parquet-wasm `Table`.
3. Serializes via `wasmTable.intoIPCStream()` → reconstructs with `tableFromIPC()` (our apache-arrow).
4. Passes the reconstructed table to `arrowToCube` → `Observations` IR.

**Export:**
1. `cubeToParquet` lazily imports `parquet-wasm`.
2. Calls `cubeToArrow(obs)` → Apache Arrow `Table`.
3. Serializes via `tableToIPC(table, "stream")` → reconstructs with `wasm.Table.fromIPCStream(ipc)` (parquet-wasm's `Table`).
4. Calls `wasm.writeParquet(wasmTable, writerProps)` → `Uint8Array`.

If `parquet-wasm` is not installed, a `ParquetSourceError` is thrown with install instructions.
