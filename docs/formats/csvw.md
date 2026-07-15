# CSVW Format

[CSV on the Web (CSVW)](https://www.w3.org/TR/tabular-metadata/) provides a metadata layer over plain CSV, declaring column types, names, and roles. This enables **lossless** CSV → JSON-stat mapping without heuristics. On export, the IR is serialized to CSV text plus a CSVW metadata JSON document.

CSVW is a **dependency-free** path — no optional peers needed. It works in both Node and the browser.

## Import path

```ts
import { csvwToCube, csvwToDataset, parseCsvwMetadata } from "jsonstat-io/csvw";
```

Or use the high-level dispatcher:

```ts
import { importToDataset } from "jsonstat-io";

// If a sibling *-metadata.json exists next to the CSV (Node):
const dataset = await importToDataset("./data.csv", { from: "csvw" });

// Or pass metadata inline:
const dataset = await importToDataset("./data.csv", {
  from: "csvw",
  csvwMetadata: metadataObject,
});
```

## Metadata structure

`csvwToCube` expects a parsed CSVW metadata object with this shape:

```json
{
  "tableSchema": {
    "columns": [
      { "titles": "year", "datatype": "string", "propertyUrl": "http://example.org/#time" },
      { "titles": "country", "datatype": "string" },
      { "titles": "amount", "datatype": "decimal" }
    ],
    "primaryKey": ["year", "country"]
  }
}
```

### Column mapping

| CSVW property                         | Maps to |
|---------------------------------------|---------|
| `titles` (first)                      | Column name |
| `datatype` = `decimal`/`integer`/`double` | Measure column |
| Other `datatype`                      | Dimension column |
| `propertyUrl` containing `#time`      | `time` role |
| `propertyUrl` containing `#geo`       | `geo` role |
| `primaryKey`                          | Dimension columns (if no explicit `options.dimensions`) |

#### Measure resolution (default-measure rule)

The measure is resolved with this precedence:

1. the column named by `options.measure`, if set; otherwise
2. a column named `value` (case-insensitive) — the **default measure**, picked even if its `datatype` is not numeric; otherwise
3. the first column whose `datatype` is `decimal`/`integer`/`double`.

This matches the plain-CSV default (see [csv.md](./csv.md)), so the canonical tidy form `…,status,value` imports without an explicit `--measure` whether or not the `value` field carries a numeric `datatype`.

### Role detection from `propertyUrl`

The adapter checks if the `propertyUrl` contains a fragment hint:

- `...#time` or `...#temporal` → `time` role
- `...#geo` or `...#spatial` → `geo` role

## Import example

```ts
import { csvwToDataset, parseCsvwMetadata } from "jsonstat-io/csvw";
import { readFileSync } from "node:fs";

const csvText = readFileSync("./sales.csv", "utf8");
const metadataJson = JSON.parse(readFileSync("./sales-metadata.json", "utf8"));
const metadata = parseCsvwMetadata(metadataJson);

const dataset = csvwToDataset(csvText, metadata, {
  dimensions: ["year", "country"],  // optional: overrides primaryKey
  roles: { time: ["year"] },        // optional: overrides propertyUrl
});
```

## Export path

[`cubeToCsvw`](../../src/sources/csvw.ts) serializes the `Observations` IR to a CSV text string **plus** a CSVW metadata JSON object, so the pair round-trips losslessly back through `csvwToCube`.

```ts
import { exportDataset } from "jsonstat-io";

// JSON-stat → CSV text + CSVW metadata
const { csv, metadata } = await exportDataset(dataset, { to: "csvw" });
```

Or use `cubeToCsvw` directly on the IR:

```ts
import { cubeToCsvw } from "jsonstat-io/csvw";

const { csv, metadata } = cubeToCsvw(obs);
// csv: string           — the CSV text
// metadata: CsvwMetadata — the CSVW metadata object (JSON-serializable)
```

The metadata object includes `@context`, `url`, `tableSchema` (columns with `titles`, `datatype`, `propertyUrl`), `primaryKey` (dimension IDs), and `dc:title`/`dc:source` from the dataset label/source.

### CLI

```sh
# JSON-stat → CSV + sibling CSVW metadata file
npx jsonstat-io ./sales.jsonstat.json --to csvw -o sales.csvw

# With -o, writes sales.csvw and sales-metadata.json
# Without -o, prints CSV + a separator + metadata JSON to stdout
```

## Import CLI

```sh
# Auto-loads sibling *-metadata.json
npx jsonstat-io ./sales.csv --from csvw

# Inline metadata
npx jsonstat-io ./sales.csv --from csvw \
  --csvw-metadata '{"tableSchema":{"columns":[{"titles":"year"},{"titles":"amount","datatype":"decimal"}],"primaryKey":["year"]}}'
```

When `--from csvw` is set and no metadata is supplied, the CLI tries to load `sales-metadata.json` next to `sales.csv`. If not found, it throws with a helpful message suggesting `--from csv` instead.

## Plain CSV (no metadata)

For plain CSV without a metadata file, use [`jsonstat-io/csv`](./csv.md) which infers the measure and dimensions heuristically:

```ts
import { csvToCube } from "jsonstat-io/csv";

const obs = csvToCube(csvText, { measure: "amount" });
```

See the [CSV adapter](../../src/sources/csv.ts) for inference rules: first all-numeric column = measure, `status`-named column = status, everything else = dimension.

## Options

### Import (`csvwToCube`)

| Field        | Type       | Description |
|--------------|------------|-------------|
| `measure`    | `string`   | Override the detected measure column |
| `dimensions` | `string[]` | Override dimension columns (overrides primaryKey) |
| `status`     | `string`   | Status column name |
| `roles`      | `RoleMap`  | Role assignments (overrides propertyUrl) |

### Export (`CubeToCsvwOptions`)

| Field        | Type     | Default | Description |
|--------------|----------|---------|-------------|
| `delimiter`  | `string` | `","`   | CSV delimiter. |
