# CSV Format

Plain CSV (no metadata) is the simplest path. The [`csvToCube`](../../src/sources/csv.ts) adapter infers the measure and dimensions heuristically on import. On export, [`cubeToCsv`](../../src/sources/csv.ts) serializes the IR to CSV text. It is **dependency-free** and works in both Node and the browser.

## Import path

```ts
import { csvToCube, parseCsv } from "jsonstat-io/csv";
```

Or use the high-level dispatcher:

```ts
import { importToDataset } from "jsonstat-io";
const dataset = await importToDataset("./data.csv", { from: "csv", measure: "amount" });
```

## Inference heuristics (no metadata)

Without a schema, the adapter infers:

1. The **measure** is resolved with this precedence:
   - the column named by `options.measure`, if set; otherwise
   - a column named `value` (case-insensitive) — this is the **default measure**; otherwise
   - the first column that parses as a number for every non-empty row (numeric inference).

   So a tidy CSV with a `value` column needs no `--measure`/`options.measure` at all. The canonical tidy form `…,status,value` (dimensions, then status, then measure) imports cleanly out of the box.
2. A column named `status` (case-insensitive) is the **status** column — unless `options.status` overrides it.
3. Every other column is a **dimension** (string-typed), in file order.

Empty cells become `null` in the measure and `""` in dimensions. For richer, lossless mapping with declared types/labels/roles, use [CSVW](./csvw.md) instead.

## Import example

```ts
import { csvToCube } from "jsonstat-io/csv";
import { buildDataset } from "jsonstat-io";

const csvText = `year,country,amount
2020,Spain,100
2020,France,200
2021,Spain,150
2021,France,250`;

const obs = csvToCube(csvText, {
  measure: "amount",
  roles: { time: ["year"], geo: ["country"] },
});

const { dataset } = buildDataset(obs, { valueForm: "dense" });
```

## Export path

[`cubeToCsv`](../../src/sources/csv.ts) serializes the `Observations` IR to CSV text. The output has one column per dimension (in `id[]` order), followed by the measure column, and an optional status column.

```ts
import { exportDataset } from "jsonstat-io";

// JSON-stat → CSV text
const csv = await exportDataset(dataset, { to: "csv" });
```

Or use `cubeToCsv` directly on the IR:

```ts
import { cubeToCsv } from "jsonstat-io/csv";

const csv = cubeToCsv(obs, { delimiter: ";" });
```

### CLI

```sh
# JSON-stat → CSV
npx jsonstat-io ./data.jsonstat.json --to csv -o data.csv

# With custom delimiter via CSVW metadata (CSV itself has no delimiter flag)
npx jsonstat-io ./data.jsonstat.json --to csvw -o data.csvw --delimiter ";"
```

## Import CLI

```sh
# From a file
npx jsonstat-io ./data.csv --from csv --measure amount --role time=year,geo=country

# From stdin
cat data.csv | npx jsonstat-io - --measure amount

# Custom delimiter
npx jsonstat-io ./data.csv --delimiter ";"
```

When `--from` is omitted, `.csv` extension triggers CSV detection. The CLI checks for a sibling `*-metadata.json` first; if found, it uses CSVW, otherwise plain CSV.

## Options

### `CsvToCubeOptions` (import)

| Field        | Type                              | Default  | Description |
|--------------|-----------------------------------|----------|-------------|
| `measure`    | `string`                          | *(inferred)* | Explicit measure column name |
| `dimensions` | `string[]`                        | *(inferred)* | Explicit dimension column names |
| `status`     | `string`                          | *(inferred)* | Status column name |
| `roles`      | `RoleMap`                         | —        | Role assignments |
| `valueForm`  | `"auto" \| "dense" \| "sparse"`  | `"auto"` | Value form hint |
| `delimiter`  | `string`                          | `","`    | CSV delimiter |
| `header`     | `boolean`                         | `true`   | Treat first row as header |

### `CubeToCsvOptions` (export)

| Field           | Type     | Default | Description |
|-----------------|----------|---------|-------------|
| `delimiter`     | `string` | `","`   | CSV delimiter. |
| `lineTerminator`| `string` | `"\n"`  | Row separator. |

## Parser

The bundled `parseCsv(input, delimiter?)` is a tiny, dependency-free RFC-4180-ish CSV parser. It handles quoted fields, embedded quotes (doubled), and embedded newlines. For heavy CSV work (large files, complex quoting), prefer piping through DuckDB or Polars.
