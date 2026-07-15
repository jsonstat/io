# Data Package Format

A [Frictionless Data Package](https://datapackage.org/) is a JSON descriptor (`datapackage.json`) that lists one or more *resources*, each pointing at a data file (typically CSV) and declaring a `schema` with typed `fields` and a `primaryKey`. This is conceptually parallel to [CSVW](./csvw.md): both attach a typed schema to a CSV file. The two differ in vocabulary — Data Package uses lowercase JSON Table Schema field `type`s (`integer`, `number`, `string`, …) and puts `primaryKey` on the schema, while CSVW uses `datatype` + `propertyUrl` + `tableSchema`. On export, the IR is serialized to CSV text plus a Data Package descriptor, so the pair round-trips losslessly.

Data Package is a **dependency-free** path — no optional peers needed. It works in both Node and the browser.

The adapter handles the **single-resource** case (the common one for statistical datasets): the first resource whose data is CSV-shaped is read. `options.resourcePath` or `options.resourceIndex` selects a non-first resource. Multi-resource packages are out of scope — split them first.

## Import path

```ts
import {
  datapackageToCube,
  datapackageToDataset,
  parseDataPackageMetadata,
} from "jsonstat-io/datapackage";
```

Or use the high-level dispatcher, which supports **two modes**:

```ts
import { importToDataset } from "jsonstat-io";

// Mode A — CSV body as source, descriptor supplied inline:
const dataset = await importToDataset("./data.csv", {
  from: "datapackage",
  datapackageMetadata: descriptorObject,
});

// Mode B — datapackage.json as source; the dispatcher parses it and
// auto-loads the resource's CSV from the path declared in the descriptor:
const dataset = await importToDataset("./datapackage.json", {
  from: "datapackage",
});
```

In Mode B the resource CSV is resolved relative to the descriptor location (URL or file path). Resources that declare inline `data` (an array of row objects) need no CSV load.

## Descriptor structure

`datapackageToCube` expects a parsed Data Package descriptor with this shape (only the fields the adapter uses are shown):

```json
{
  "name": "sales-by-year",
  "title": "Sales by year and country",
  "resources": [
    {
      "name": "sales",
      "path": "sales.csv",
      "dialect": { "delimiter": ",", "header": true },
      "schema": {
        "fields": [
          { "name": "year", "type": "year", "rdfType": "https://schema.org/DateTime" },
          { "name": "country", "type": "string" },
          { "name": "amount", "type": "number" }
        ],
        "primaryKey": ["year", "country"],
        "missingValues": [""]
      }
    }
  ]
}
```

Dataset-level fields (`title`, `sources`, `created`, `licenses`) map to JSON-stat dataset properties. The `jsonstat:*` keys are a **vendor extension** for lossless round-trip of roles, value-form, and extension:

| Key                     | Maps to |
|-------------------------|---------|
| `jsonstat:roles`        | IR `model.roles` (`{ time, geo, metric }`) |
| `jsonstat:valueForm`    | IR `model.valueForm` (`auto` / `dense` / `sparse`) |
| `jsonstat:extension`    | Dataset `extension` object |

### Field mapping

| Data Package field property                | Maps to |
|--------------------------------------------|---------|
| `name`                                     | Dimension / measure / status id |
| `title`                                    | Column label (falls back to `name`) |
| `type` = `integer` / `number`              | Measure candidate (numeric) |
| `type` = `string` / `year` / `date` / …    | Dimension (or status) column |
| `rdfType` containing `time`/`date`         | `time` role |
| `rdfType` containing `geo`/`place`         | `geo` role |
| `rdfType` containing `metric`/`measure`    | `metric` role |
| `primaryKey`                               | Dimension columns (if no explicit `options.dimensions`) |
| `schema.missingValues`                     | Treated as null |

Non-`primaryKey`, non-measure, non-status fields are appended as trailing dimensions in declaration order.

#### Measure resolution (default-measure rule)

The measure is resolved with this precedence:

1. the field named by `options.measure`, if set; otherwise
2. a field named `value` (case-insensitive) — the **default measure**, picked even if its `type` is not numeric; otherwise
3. the first field whose `type` is `integer` or `number`.

This matches the plain-CSV and CSVW defaults (see [csv.md](./csv.md) and [csvw.md](./csvw.md)), so the canonical tidy form `…,status,value` imports without an explicit `--measure` whether or not the `value` field carries a numeric `type`.

#### Status resolution

A field named `status` (case-insensitive) is treated as the status column unless `options.status` names another. The measure column is never reused as status.

### Role detection from `rdfType`

The adapter inspects a field's `rdfType` (analogous to CSVW `propertyUrl`) for vocabulary hints, case-insensitively:

- `…time` / `…date` / `…temporal` → `time` role
- `…geo` / `…spatial` / `…place` → `geo` role
- `…metric` / `…measure` / `…observation` → `metric` role

On export the inverse mapping emits schema.org URLs (`DateTime`, `Place`, `Measure`) so the role survives a round-trip.

## Import example

```ts
import { datapackageToDataset, parseDataPackageMetadata } from "jsonstat-io/datapackage";
import { readFileSync } from "node:fs";

const csvText = readFileSync("./sales.csv", "utf8");
const descriptorJson = JSON.parse(readFileSync("./datapackage.json", "utf8"));
const metadata = parseDataPackageMetadata(descriptorJson);

const dataset = datapackageToDataset(csvText, metadata, {
  dimensions: ["year", "country"],  // optional: overrides primaryKey
  roles: { time: ["year"] },        // optional: overrides rdfType
});

// Or, when the resource carries inline `data`, the csvText is ignored:
const dataset2 = datapackageToDataset("", metadata, {
  resourceIndex: 0,
});
```

## Export path

[`cubeToDataPackage`](../../src/sources/datapackage.ts) serializes the `Observations` IR to a CSV text string **plus** a Data Package descriptor, so the pair round-trips losslessly back through `datapackageToCube`.

```ts
import { exportDataset } from "jsonstat-io";

// JSON-stat → CSV text + Data Package descriptor
const { csv, metadata } = await exportDataset(dataset, { to: "datapackage" });
```

Or use `cubeToDataPackage` directly on the IR:

```ts
import { cubeToDataPackage } from "jsonstat-io/datapackage";

const { csv, metadata } = cubeToDataPackage(obs);
// csv: string                  — the CSV text (RFC-4180)
// metadata: DataPackageMetadata — the descriptor (JSON-serializable)
```

The descriptor's single resource schema records, per field:

- `name` (the dimension id / measure name / `"status"`),
- `title` (the dimension label, when known),
- `type` (`string` for dimensions and status, `number` for the measure),
- `rdfType` (a role-derived schema.org URL, when a role is assigned).

The schema's `primaryKey` is set to all dimension fields — together they uniquely identify an observation. Dataset-level metadata (`label`, `source`, `updated`, `extension`, `roles`, `valueForm`) is emitted as package-level fields and `jsonstat:*` keys.

### CLI

```sh
# JSON-stat → CSV + sibling datapackage.json descriptor
npx jsonstat-io ./sales.jsonstat.json --to datapackage -o sales.csv

# With -o, writes sales.csv and sales.datapackage.json
# Without -o, prints CSV + a separator + descriptor JSON to stdout
```

## Import CLI

```sh
# Mode B — datapackage.json as source; resource CSV auto-loaded
npx jsonstat-io ./datapackage.json --from datapackage

# Mode A — CSV as source, descriptor inline
npx jsonstat-io ./sales.csv --from datapackage \
  --datapackage-metadata '{"resources":[{"path":"sales.csv","schema":{"fields":[{"name":"year"},{"name":"amount","type":"number"}],"primaryKey":["year"]}}]}'
```

When `--from datapackage` is set and no descriptor is supplied, the loaded source is treated as the descriptor itself (Mode B). Pass `--datapackage-metadata` to use Mode A instead.

## Plain CSV (no metadata)

For plain CSV without a descriptor, use [`jsonstat-io/csv`](./csv.md) which infers the measure and dimensions heuristically:

```ts
import { csvToCube } from "jsonstat-io/csv";

const obs = csvToCube(csvText, { measure: "amount" });
```

See the [CSV adapter](../../src/sources/csv.ts) for inference rules: first all-numeric column = measure, `status`-named column = status, everything else = dimension.

## Options

### Import (`DataPackageToCubeOptions`)

| Field            | Type       | Description |
|------------------|------------|-------------|
| `measure`        | `string`   | Override the detected measure field |
| `dimensions`     | `string[]` | Override dimension fields (overrides primaryKey) |
| `status`         | `string`   | Status field name |
| `roles`          | `RoleMap`  | Role assignments (merged with, and overriding, `rdfType` hints) |
| `resourcePath`   | `string`   | Select a resource by `path` (multi-resource packages) |
| `resourceIndex`  | `number`   | Select a resource by zero-based index (default `0`) |
| `delimiter`      | `string`   | CSV delimiter override (default: from resource `dialect`, or `","`) |

### Export (`CubeToDataPackageOptions`)

| Field              | Type     | Default       | Description |
|--------------------|----------|---------------|-------------|
| `delimiter`        | `string` | `","`         | CSV delimiter |
| `lineTerminator`   | `string` | `"\r\n"`      | Line terminator (`"\r\n"` or `"\n"`) |
| `path`             | `string` | `"data.csv"`  | The `path` of the CSV the resource describes |
| `name`             | `string` | slug of label | The package `name` slug |
