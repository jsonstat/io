# CLI Reference

```sh
npx jsonstat-io [input] [options]
```

## Synopsis

```
jsonstat-io [input] [options]

Convert between columnar data (Arrow, Parquet, DuckDB, Polars, CSVW, CSV, Data Package) and JSON-stat 2.0 cubes.

Arguments:
  input                    Input file path, URL, or "-" for stdin (default: "-").
                           Supports .parquet, .arrow/.ipc, .csv, .csvw, .jsv/.csvstat,
                           .datapackage/.datapackage.json/.json (with a `resources[]`
                           shape), .json/.jsonstat.

Options:
  -V, --version            Print version and exit.
  -h, --help               Print this help and exit.

Format:
  -f, --from <format>      Source format override. One of:
                             auto (default) — sniff from magic bytes + extension
                             parquet        — needs parquet-wasm
                             arrow          — Arrow IPC stream/file
                             csv            — plain CSV (heuristic mapping)
                             csvw           — CSV with metadata
                             jsv            — CSV-stat (JSV): CSV with inline metadata header
                             datapackage    — Frictionless Data Package descriptor
                             jsonstat, json — JSON-stat input (round-trip)
  -t, --to <format>        Output format / direction. One of:
                             jsonstat (default) — IMPORT: columnar → JSON-stat
                             arrow              — EXPORT: JSON-stat → Arrow IPC
                             parquet            — EXPORT: JSON-stat → Parquet (needs parquet-wasm)
                             csv                — EXPORT: JSON-stat → CSV
                             csvw               — EXPORT: JSON-stat → CSV + CSVW metadata
                             jsv                — EXPORT: JSON-stat → CSV-stat (JSV) text
                             datapackage        — EXPORT: JSON-stat → CSV + Data Package descriptor

Column mapping:
      --measure <column>   Name of the measure column (overrides detection).
      --dimensions <a,b,c> Comma-separated dimension column names, in order.
      --role <assigns>     Role assignments: time=<col>,geo=<col>,metric=<col>
                           (comma-separated). Example: --role time=year,geo=country
      --status <column>    Name of the status column.

Value form:
      --sparse             Force sparse (object) value form.
      --dense              Force dense (array) value form.
      --auto               Auto-decide value form by null ratio (default).
      --threshold <n>      Sparse threshold: null ratio 0–1 (default 0.5).

Status form:
      --status-form <form> Status emission. One of:
                             auto (default) — string if uniform, else array
                             array          — always per-cell array
                             string         — always a single string
                             object         — explicit {position: code}
                             none           — omit status entirely

Dataset metadata:
      --label <text>       Dataset label.
      --source <text>      Dataset source.
      --updated <date>     Dataset last-updated date (ISO 8601).

Output:
  -o, --output <file>      Write to file instead of stdout. For `--to csvw|datapackage`
                           the resource name/path in the descriptor are derived from
                           this stem (e.g. `-o cube.csv` → name "cube", path "cube.csv").
      --pretty             Pretty-print JSON (default: true).
      --no-pretty          Compact JSON output (single line).
      --canonical-keys     Reorder top-level keys canonically (default: true).
      --no-canonical-keys  Preserve insertion key order.
      --validate           Validate output with @jsonstat-validator/ts (if installed).

CSV/CSVW/Data Package:
      --csvw-metadata <json>       Inline CSVW metadata as a JSON string.
      --datapackage-metadata <json>  Inline Data Package descriptor as a JSON string
                                    (the CLI then reads the CSV body from [input]).
      --delimiter <char>           CSV/CSVW/CSV-stat/Data Package delimiter (default: ",").

Export-only (CSV-stat/CSV/CSVW/Data Package):
      --decimal <char>             CSV-stat (JSV) decimal mark (default: ".").
      --unit-sep <char>            CSV-stat (JSV) unit-column separator (default: "|").
      --line-terminator <eol>      Line terminator for export: "\r\n" (default) or "\n"
                                   (also accepts lf / crlf).
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0    | Success |
| 1    | Import, validation, or write error |
| 2    | Invalid CLI arguments |

## Examples

### IMPORT: Parquet → JSON-stat file

```sh
npx jsonstat-io ./sales.parquet -o sales.jsonstat.json --label "Sales 2024"
```

### IMPORT: CSV on stdin with explicit roles

```sh
cat data.csv | npx jsonstat-io - --measure amount --role time=year,geo=country
```

### IMPORT: Arrow IPC from a URL, forced sparse

```sh
npx jsonstat-io https://example.com/data.arrow --sparse --threshold 0.3
```

### IMPORT: CSVW with inline metadata

```sh
npx jsonstat-io ./data.csv --from csvw \
  --csvw-metadata '{"tableSchema":{"columns":[{"titles":"year","datatype":"string"},{"titles":"value","datatype":"decimal"}],"primaryKey":["year"]}}'
```

### IMPORT: Data Package with inline descriptor

```sh
npx jsonstat-io ./data.csv --from datapackage \
  --datapackage-metadata '{"resources":[{"name":"data","path":"data.csv","schema":{"fields":[{"name":"year","type":"year"},{"name":"value","type":"number"}],"primaryKey":["year"]}}]}'
```

The CLI reads the CSV body from `[input]` and the descriptor from
`--datapackage-metadata`; it also accepts a descriptor file directly as `[input]`
(see [Data Package format](./formats/datapackage.md)).

### IMPORT: JSON-stat round-trip (re-emit with canonical keys)

```sh
npx jsonstat-io ./input.jsonstat --from jsonstat --canonical-keys -o canonical.jsonstat.json
```

### EXPORT: JSON-stat → Parquet

```sh
npx jsonstat-io ./sales.jsonstat.json --to parquet -o sales.parquet
```

### EXPORT: JSON-stat → Arrow IPC

```sh
npx jsonstat-io ./sales.jsonstat.json --to arrow -o sales.arrow
```

### EXPORT: JSON-stat → CSV (+ sibling CSVW metadata)

```sh
npx jsonstat-io ./sales.jsonstat.json --to csv -o sales.csv
# writes sales.csv and sales-metadata.json
```

### EXPORT: JSON-stat → CSVW (with explicit CSVW metadata)

```sh
npx jsonstat-io ./sales.jsonstat.json --to csvw -o sales.csvw
```

### EXPORT: JSON-stat → Data Package (CSV + datapackage.json)

```sh
npx jsonstat-io ./sales.jsonstat.json --to datapackage -o sales.csv
# writes sales.csv and datapackage.json (sibling)
```

The resource `name` and `path` in the descriptor are derived from the `-o` stem:
`-o sales.csv` produces `"name": "sales"` and `"path": "sales.csv"`, so the
descriptor references the CSV that is actually written (round-trippable). When
`-o` is omitted (stdout output), the writer falls back to a slug of the dataset
label and `"data.csv"`.

### Validate the output

```sh
npm i -g @jsonstat-validator/ts
npx jsonstat-io ./sales.parquet --validate
```

If `@jsonstat-validator/ts` is not installed, `--validate` prints a hint instead of failing.

## How detection works

When `--from` is omitted (or `auto`), the CLI:

1. Reads magic bytes: `PAR1` → Parquet, `ARROW1` → Arrow IPC.
2. Falls back to the file extension:
   - `.parquet` → Parquet
   - `.arrow` / `.ipc` / `.feather` → Arrow IPC
   - `.csv` → CSV (with sibling lookup, see step 3)
   - `.csvw` / `.csv-metadata` → CSVW
   - `.jsv` / `.csvstat` → CSV-stat (JSV)
   - `.datapackage` / `.data-package` / `.fdp` → Data Package
   - `.json` / `.jsonstat` / `.json-stat` → JSON-stat
3. For `.csv`, tries to load a sibling `*-metadata.json` (CSVW convention). If found, uses CSVW; otherwise plain CSV.

> **Note on `.json` and Data Packages.** A bare `.json` extension maps to
> JSON-stat by default. To import a Frictionless Data Package descriptor that
> ends in `.json` (e.g. `datapackage.json`), pass `--from datapackage`
> explicitly, or rename/re-symlink it to a `.datapackage` / `.fdp` extension.
> Alternatively, pass the CSV body as `[input]` together with
> `--datapackage-metadata '<json>'` (the descriptor is then read from the flag,
> not the file).

DuckDB and Polars require a live connection or DataFrame object and are **not** available via the CLI — use the programmatic API ([`docs/formats/duckdb.md`](./formats/duckdb.md), [`docs/formats/polars.md`](./formats/polars.md)).
