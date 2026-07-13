# Polars Format

Convert a Polars `DataFrame` (from [`nodejs-polars`](https://pola-rs.github.io/nodejs-polars/)) to JSON-stat via the [Arrow hub](./arrow.md). Polars DataFrames expose `toArrow()` / `toIPC()`, which produce Apache Arrow tables. On export, the Arrow table is converted back to a Polars DataFrame via `fromArrow()`.

## Install

```sh
npm install jsonstat-io nodejs-polars
```

`nodejs-polars` is an **optional peer dependency**. It is a native Node module — **Node only**. It cannot run in the browser.

## Import path

```ts
import { polarsToCube, polarsToDataset, loadPolars } from "jsonstat-io/polars";
```

The Polars adapter is **not** available via the CLI for import — it requires a live DataFrame object.

## Import example

```ts
import { polarsToDataset, loadPolars } from "jsonstat-io/polars";

const pl = await loadPolars();
const df = pl.readCSV("sales.csv");

const dataset = await polarsToDataset(df, {
  measure: "amount",
  roles: { time: ["year"], geo: ["country"] },
});
```

`loadPolars()` lazily imports `nodejs-polars` so it never enters a bundle that doesn't use it. You can also import `nodejs-polars` directly and pass the DataFrame.

## Reading Parquet via Polars

Polars can read Parquet natively (often faster than `parquet-wasm` in Node):

```ts
import { polarsToDataset, loadPolars } from "jsonstat-io/polars";

const pl = await loadPolars();
const df = pl.readParquet("sales.parquet");
const dataset = await polarsToDataset(df);
```

## Export path

[`cubeToPolars`](../../src/sources/polars.ts) converts the `Observations` IR to a Polars `DataFrame`: it calls `cubeToArrow` to build the Arrow table, then `pl.fromArrow(table)` to materialize the DataFrame.

```ts
import { exportDataset } from "jsonstat-io";

// JSON-stat → Polars DataFrame
const df = await exportDataset(dataset, { to: "polars" });
```

Or use `cubeToPolars` directly on the IR:

```ts
import { cubeToPolars, loadPolars } from "jsonstat-io/polars";

await loadPolars();  // ensure nodejs-polars is imported
const df = await cubeToPolars(obs);
```

## Options

### `PolarsToCubeOptions` (import)

Extends [`ArrowToCubeOptions`](./arrow.md):

| Field        | Type                              | Description |
|--------------|-----------------------------------|-------------|
| `arrowMethod`| `"toArrow" \| "toIPC" \| "auto"` | Force a specific Arrow conversion method. Default `"auto"` tries `toArrow()` then `toIPC()`. |
| `measure`    | `string`                          | Measure column name |
| `dimensions` | `string[]`                        | Dimension column names |
| `roles`      | `RoleMap`                         | Role assignments |

### `CubeToPolarsOptions` (export)

| Field   | Type                                  | Default | Description |
|---------|---------------------------------------|---------|-------------|
| `method`| `"fromArrow" \| "ipc" \| "auto"`     | `"auto"`| Conversion method: `pl.fromArrow(table)` or round-trip through IPC. |

## How it works

**Import:**
1. `polarsToCube` extracts an Arrow Table from the DataFrame, trying `toArrow()` first, then `toIPC()` (decoded via `tableFromIPC`).
2. Passes the table to `arrowToCube` → `Observations` IR.

**Export:**
1. `cubeToPolars` calls `cubeToArrow(obs)` → Apache Arrow `Table`.
2. Converts via `pl.fromArrow(table)` (or round-trips through IPC if `fromArrow` is unavailable).

If `nodejs-polars` is not installed or the DataFrame has no `toArrow()`/`toIPC()` method, a `PolarsSourceError` is thrown.

## Browser alternative

For browser Polars data, convert to Arrow IPC first (Polars can serialize to IPC), then use the Arrow hub directly:

```ts
import { arrowToDataset } from "jsonstat-io";
import { tableFromIPC } from "apache-arrow";

const ipcBytes = /* obtain Arrow IPC bytes */;
const table = tableFromIPC(ipcBytes);
const dataset = arrowToDataset(table);
```
