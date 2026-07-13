# Arrow Format

Apache Arrow is the **hub** of `jsonstat-io`. Parquet, DuckDB, and Polars all produce Arrow tables, and a single converter pair ([`arrowToCube`](../../src/arrow/arrowToCube.ts) / [`cubeToArrow`](../../src/arrow/arrowFromCube.ts)) handles them all in both directions.

## Import path

```ts
import { arrowToCube, arrowToDataset } from "jsonstat-io";
// or from the dedicated subpath:
import { arrowToCube } from "jsonstat-io/arrow";
```

`apache-arrow` is a **hard dependency** — no peer install needed.

## Reading an Arrow IPC file

```ts
import { tableFromIPC } from "apache-arrow";
import { arrowToDataset } from "jsonstat-io";
import { readFileSync } from "node:fs";

const bytes = readFileSync("./data.arrow");
const table = tableFromIPC(bytes);
const dataset = arrowToDataset(table, { measure: "amount" });
```

In the browser, fetch the bytes and pass them directly:

```ts
const res = await fetch("/data.arrow");
const bytes = new Uint8Array(await res.arrayBuffer());
const table = tableFromIPC(bytes);
const dataset = arrowToDataset(table);
```

## How Arrow columns map

| Arrow column type            | JSON-stat role   | Detection |
|------------------------------|------------------|-----------|
| `Dictionary<Utf8, Int*>`     | dimension        | Always a dimension |
| `Utf8`, `Bool`, temporal     | dimension        | Stringified |
| `Float64`, `Float32`, `Int*` | measure (first)  | First numeric column, unless overridden |
| Any column with `jsonstat.status: "true"` | status | Metadata marker |

### Without metadata (heuristic mode)

`arrowToCube` infers:
1. The first `Float64`/`Float32`/`Int64`/`Int32` column is the **measure**.
2. A column named `status` (case-insensitive) is the **status** column.
3. All other columns are **dimensions**, in schema order.
4. Roles: `year`/`date`/`time`/`period` → `time`; `country`/`region`/`geo`/`area` → `geo`; the measure → `metric`.

### With metadata (lossless mode)

Annotate Arrow `Field` and `Schema` metadata with `jsonstat.*` keys for exact, lossless mapping. See the [metadata key reference](../mapping.md#arrow-schema-metadata-contract).

```ts
import { Field, Schema, Dictionary, Utf8, Int32, Float64 } from "apache-arrow";
import { buildFieldMeta, buildSchemaMeta } from "jsonstat-io";

const yearField = new Field("year", new Dictionary(new Utf8(), new Int32()), false,
  new Map(Object.entries(buildFieldMeta({
    role: "time",
    label: "Year",
    categoryOrder: ["2020", "2021", "2022"],
    categoryLabels: { "2020": "FY 2020", "2021": "FY 2021" },
  })))
);

const schema = new Schema(
  [yearField, /* ... */],
  new Map(Object.entries(buildSchemaMeta({ label: "Annual Sales", source: "Finance Dept" })))
);
```

## Annotating for round-trip fidelity

To guarantee that `arrowToCube` → `cubeToArrow` round-trips losslessly, annotate:

- **Schema**: `jsonstat.label`, `jsonstat.source`, `jsonstat.updated`, `jsonstat.valueForm`.
- **Each dimension field**: `jsonstat.role`, `jsonstat.label`, `jsonstat.categoryLabels`, `jsonstat.categoryUnits`, `jsonstat.categoryCoords`, `jsonstat.categoryChild`, `jsonstat.categoryOrder`.
- **Measure field**: `jsonstat.measure: "true"` (or `jsonstat.role: "metric"`).
- **Status field**: `jsonstat.status: "true"`.

## Export path

[`cubeToArrow`](../../src/arrow/arrowFromCube.ts) converts the `Observations` IR back to an Arrow `Table`, building dictionary-encoded dimensions and a Float64 measure with full `jsonstat.*` metadata annotation.

```ts
import { exportDataset } from "jsonstat-io";

// JSON-stat → Arrow Table
const table = await exportDataset(dataset, { to: "arrow" });
```

Or use `cubeToArrow` directly on the IR:

```ts
import { cubeToArrow } from "jsonstat-io";
// obs = Observations IR
const table = cubeToArrow(obs);
```

### CLI

```sh
# JSON-stat → Arrow IPC file
npx jsonstat-io ./data.jsonstat.json --to arrow -o data.arrow
```

The exporter writes Arrow IPC stream format. `cubeToArrow` is also the foundation for the Parquet, DuckDB, and Polars exporters — they all call `cubeToArrow` first, then convert the resulting Arrow Table to their target format.
