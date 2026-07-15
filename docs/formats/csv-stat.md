# CSV-stat (JSV) Format

CSV-stat — also called **JSV** — is CSV plus an extra metadata header that round-trips the JSON-stat dataset core: dimensions, category ids/labels/order, roles, metric units, status, and dataset-level `label`/`source`/`updated`/`href`. Unlike [plain CSV](./csv.md) (heuristic, lossy) or [CSVW](./csvw.md) (sidecar JSON metadata), JSV keeps *everything in a single file* with the metadata inline. The [`csvstatToCube`](../../src/sources/csvstat.ts) adapter parses it into the IR; [`cubeToCsvstat`](../../src/sources/csvstat.ts) writes the IR back to JSV text. It is **dependency-free** and works in both Node and the browser.

The format identifier is **`jsv`** (its accepted short name and the `.jsv` extension). The extension `.csvstat` is also detected as a synonym. The subpath is `jsonstat-io/jsv`.

## File structure

A JSV file begins with a metadata header, then a `data` marker, then the tidy CSV body:

```
jsonstat,{decimal},{unitSep}
[label,{text}]
[source,{text}]
[updated,{text}]
[href,{url}]
dimension,{id},{label},{size},{catId},{catLabel}×size[,{role}][,{unit}×size]
…one dimension line per dimension…
data
{dimId}…[,status],value
{catId}…[,status],{value}
…one data record per cell…
```

- **`jsonstat` line** (required, first): `jsonstat,{decimal},{unitSep}` — the decimal mark for value cells (default `.`) and the separator inside unit columns (default `|`).
- **`label` / `source` / `updated` / `href`** (optional): single-value dataset metadata lines.
- **`dimension` line** (one per dimension): `dimension,{id},{label},{size}`, followed by `{size}` id/label pairs, optionally a role token (`geo|time|metric`), and — for metric dimensions carrying units — `{size}` unit columns in the form `decimals|label|symbol|position` (split on the unit separator).
- **`data` marker** (required): a lone `data` line separating header from CSV body.
- **CSV body**: a header of `{dimId}…[,status],value` (the value column is always last and always named `value`; an optional `status` column sits immediately before it), then one row per observation. Missing values are written as empty value cells (non-numeric cells on import become `null`).

See the [authoritative format spec](https://jsonstat.org/format/#csv-stat) for the full grammar and a worked example.

## Import path

```ts
import { csvstatToCube } from "jsonstat-io/jsv";
```

Or use the high-level dispatcher:

```ts
import { importToDataset } from "jsonstat-io";
const dataset = await importToDataset("./data.jsv", { from: "jsv" });
```

Because the metadata header is explicit, **no inference is needed** — the measure is always the `value` column, dimensions and their roles/labels/units are declared, and a `status` column (when present) is recognised automatically.

## Import example

```ts
import { csvstatToCube } from "jsonstat-io/jsv";
import { buildDataset } from "jsonstat-io";

const jsv = `jsonstat,.,|
label,My dataset
dimension,year,Year,2,2020,2020,2021,2021,time
dimension,geo,Geography,2,ES,Spain,FR,France,geo
data
year,geo,value
2020,ES,100
2020,FR,200
2021,ES,150
2021,FR,250`;

const obs = csvstatToCube(jsv);
const { dataset } = buildDataset(obs, { valueForm: "dense" });
```

The resulting IR carries `categoryOrder`, `categoryLabels`, `categoryUnits` (for metric dimensions), `roles`, and `meta` (`label`/`source`/`updated`/`href`) straight from the header — so a JSV → JSON-stat → JSV round-trip is byte-stable for canonical inputs.

## Export path

[`cubeToCsvstat`](../../src/sources/csvstat.ts) serializes the `Observations` IR to JSV text. It emits the `jsonstat` line, optional metadata lines, one `dimension` line per dimension (with category ids/labels, roles, and unit columns where applicable), the `data` marker, then the tidy CSV records (dimensions [+ status] + value).

```ts
import { exportDataset } from "jsonstat-io";

// JSON-stat → JSV text
const jsv = await exportDataset(dataset, { to: "jsv" });
```

Or use `cubeToCsvstat` directly on the IR:

```ts
import { cubeToCsvstat } from "jsonstat-io/jsv";

const jsv = cubeToCsvstat(obs, { delimiter: ";" });
```

### CLI

```sh
# JSON-stat → JSV
npx jsonstat-io ./data.jsonstat.json --to jsv -o data.jsv

# Custom decimal/unit separator written to the jsonstat line
npx jsonstat-io ./data.jsonstat.json --to jsv --decimal "," --unit-sep "|" -o data.jsv
```

## Import CLI

```sh
# From a file (auto-detected from .jsv / .csvstat extension)
npx jsonstat-io ./data.jsv

# Force the format
npx jsonstat-io ./data.txt --from jsv

# From stdin
cat data.jsv | npx jsonstat-io -

# Locale pairing: comma decimal requires a non-comma column delimiter
npx jsonstat-io ./data.jsv --delimiter ";" --decimal ","
```

When `--from` is omitted, `.jsv` and `.csvstat` extensions trigger JSV detection; the leading `jsonstat,` magic on the first line is also detected from raw bytes.

## Options

### `CsvStatToCubeOptions` (import)

| Field        | Type                              | Default         | Description |
|--------------|-----------------------------------|-----------------|-------------|
| `delimiter`  | `string`                          | `","`           | CSV column delimiter. |
| `decimal`    | `string`                          | *(from header)* | Decimal mark for value cells; overrides the `jsonstat` line. |
| `valueForm`  | `"auto" \| "dense" \| "sparse"`  | `"auto"`        | Value-form hint passed to the cube model. |

> **Locale note:** when the decimal mark is a comma (`,`), the column delimiter **must** be something else (e.g. `;`) — a comma decimal paired with a comma column delimiter is ambiguous and will not parse. Use the realistic pairing `delimiter: ";"`, `decimal: ","`.

### `CubeToCsvStatOptions` (export)

| Field             | Type     | Default  | Description |
|-------------------|----------|----------|-------------|
| `delimiter`       | `string` | `","`    | CSV column delimiter. |
| `decimal`         | `string` | `"."`    | Decimal mark written to the `jsonstat` line. |
| `unitSep`         | `string` | `"|"`    | Unit-column separator written to the `jsonstat` line. |
| `lineTerminator`  | `string` | `"\r\n"` | Row separator (`"\n"` for Unix). |

## Parser

The bundled `parseCsv(input, delimiter?)` (shared with [CSV](./csv.md)) is a tiny, dependency-free RFC-4180-ish CSV parser handling quoted fields, embedded quotes (doubled), and embedded newlines. JSV import reuses it for both the metadata header lines and the trailing CSV body. For heavy CSV work (large files, complex quoting), prefer piping through DuckDB or Polars.
