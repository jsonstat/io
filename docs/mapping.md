# Spec-Fidelity Mapping

This is the **correctness contract**: how every JSON-stat 2.0 concept maps to/from the columnar world and the internal Observations IR. If a round-trip loses information, it is a bug.

## JSON-stat ↔ Observations IR

| JSON-stat concept          | Observations IR field         | Notes |
|----------------------------|-------------------------------|-------|
| `dataset.id`               | `meta.label` / `dimensions`   | Built from dimension IDs in `id[]` order |
| `dataset.size`             | *(computed)*                  | Product of resolved category counts; not stored in IR |
| `dataset.dimension[id]`    | `dimensions[id]`              | One `DimensionColumn` per dimension |
| `dimension.category.index` | *(resolved position map)*     | Built by `resolveDimension` — explicit order or first-seen |
| `dimension.category.label` | `DimensionColumn.categoryLabels` | `{id: label}` |
| `dimension.label`          | `DimensionColumn.label`       | |
| `dataset.value` (array)    | `measure.values` scattered     | Dense form: full row-major array |
| `dataset.value` (object)   | `measure.values` scattered     | Sparse form: `{position: value}` |
| `dataset.status`           | `status.values`               | Per-row status, deduplicated on emit |
| `dataset.role`             | `roles`                       | `{time?: [], geo?: [], metric?: []}` |
| `dimension.category.unit`  | `DimensionColumn.categoryUnits` | `{id: {decimals, label}}` |
| `dimension.category.coordinates` | `DimensionColumn.categoryCoords` | `{id: [lon, lat]}` |
| `dimension.category.child` | `DimensionColumn.categoryChild` | `{parent: [child, ...]}` |
| `dimension.category.order` | `DimensionColumn.categoryOrder` | Explicit `[id, ...]` ordering |

## Arrow schema metadata contract

Producers annotate Arrow `Field` and `Schema` metadata with `jsonstat.*` keys so `arrowToCube` can reconstruct the full model losslessly. Without metadata, the converter uses heuristics (dictionary = dimension, first numeric = measure).

### Field-level keys (`Field.metadata`)

| Key                       | Value                              | Meaning |
|---------------------------|------------------------------------|---------|
| `jsonstat.role`           | `"time"` / `"geo"` / `"metric"`    | Dimension role |
| `jsonstat.measure`        | `"true"`                           | Marks this column as the measure (overrides type heuristics) |
| `jsonstat.status`         | `"true"`                           | Marks this column as the per-row status column |
| `jsonstat.label`          | string                             | Dimension label |
| `jsonstat.categoryLabels` | JSON object: `{id: label}`         | Category labels |
| `jsonstat.categoryUnits`  | JSON object: `{id: {decimals,...}}`| Per-category unit metadata (metric role) |
| `jsonstat.categoryCoords` | JSON object: `{id: [lon,lat]}`     | Per-category coordinates (geo role) |
| `jsonstat.categoryChild`  | JSON object: `{parent: [child,...]}`| Hierarchy |
| `jsonstat.categoryOrder`  | JSON array: `[id,...]`             | Explicit category ordering (e.g. chronological) |

### Schema-level keys (`Schema.metadata`)

| Key                  | Value                          | Meaning |
|----------------------|--------------------------------|---------|
| `jsonstat.label`     | string                         | Dataset label |
| `jsonstat.source`    | string                         | Dataset source |
| `jsonstat.updated`   | ISO 8601 string                | Dataset update time |
| `jsonstat.extension` | JSON object                    | Provider extension data |
| `jsonstat.valueForm` | `"auto"`/`"dense"`/`"sparse"`  | Value emission hint |

## Arrow type → JSON-stat mapping

| Arrow type                  | JSON-stat role | Notes |
|-----------------------------|----------------|-------|
| `Dictionary<Utf8, Int*>`    | dimension      | Natural fit — dictionary-encoded strings |
| `Utf8` (non-dictionary)     | dimension      | Stringified |
| `Bool`                      | dimension      | → `"true"`/`"false"` |
| `Int32`, `Int64`            | dimension or measure | Dimension if not the detected/declared measure |
| `Float32`, `Float64`        | measure (default) | First numeric column is the measure heuristic |
| `DateDay`, `DateMillisecond`| dimension (time) | ISO date string |
| `TimestampSecond/Millisecond`| dimension (time)| ISO 8601 string |
| Other types                 | dimension      | Stringified via `String(vec.get(i))` |

**Detection order** (when metadata is absent):
1. If `options.measure` is set, that column is the measure.
2. Otherwise, a column named `value` (case-insensitive) is the measure — this is the **default-measure rule** shared by the Arrow, CSV, CSVW, and Data Package adapters.
3. Otherwise, the first `Float64`/`Float32`/`Int64`/`Int32` column is the measure.
4. A column named `status` (case-insensitive) is the status column.
5. All remaining columns are dimensions, in schema order.

**Roles** (when metadata is absent):
- A dimension named `year`, `date`, `time`, or `period` (case-insensitive) gets the `time` role.
- A dimension named `country`, `region`, `geo`, or `area` gets the `geo` role.
- The measure column gets the `metric` role.
- Explicit `options.roles` merge with and take precedence over both metadata and heuristics.

## Row-major value ordering

JSON-stat stores values in **row-major** order: the first dimension varies slowest, the last dimension varies fastest. For dimensions `[sex, age, year]` with sizes `[2, 2, 2]`:

```
Position  0: sex[0], age[0], year[0]
Position  1: sex[0], age[0], year[1]
Position  2: sex[0], age[1], year[0]
Position  3: sex[0], age[1], year[1]
Position  4: sex[1], age[0], year[0]
Position  5: sex[1], age[0], year[1]
Position  6: sex[1], age[1], year[0]
Position  7: sex[1], age[1], year[1]
```

The stride of dimension `d` is the product of all subsequent sizes:

```
strides[sex]  = size[age] × size[year] = 2 × 2 = 4
strides[age]  = size[year]             = 2
strides[year] = 1
```

`flatPosition = Σ indices[d] × strides[d]`. The builder scatters each IR row's measure value into its computed position. `null` values are preserved in position (dense) or omitted (sparse).

## Dense vs sparse value form

| Form   | JSON shape               | When used |
|--------|--------------------------|-----------|
| Dense  | `"value": [10,20,...]`   | Full array, including `null` holes |
| Sparse | `"value": {"0":10,...}`  | Object with only present positions |

The `decideDensity` heuristic: if the null ratio exceeds the threshold (default `0.5`), emit sparse; otherwise dense. Override with `valueForm: "dense"` or `"sparse"`.

## Status forms

JSON-stat allows three `status` representations:

| Form   | JSON shape                  | When emitted |
|--------|-----------------------------|--------------|
| String | `"status": "p"`            | Every row has the same status |
| Array  | `"status": ["p","e",...]`  | Per-cell status, mixed |
| (none) | *(omitted)*                 | No status column present |

`statusForm: "object"` is also available to force the explicit object form `{position: code}` regardless of uniformity.

## CSVW column mapping

CSVW metadata declares column types and roles explicitly:

| CSVW property                    | Maps to                          |
|----------------------------------|----------------------------------|
| `tableSchema.columns[].titles`   | Column name (first title)        |
| `tableSchema.columns[].datatype` | Measure if `decimal`/`integer`/`double` |
| `tableSchema.columns[].propertyUrl` containing `#time` / `#geo` | Role |
| `tableSchema.primaryKey`         | Dimension columns (if no explicit dims) |

The same default-measure rule applies: when no column matches the
`datatype`-based measure detection, a column named `value` is the measure.

## Data Package (Frictionless) field mapping

A Frictionless Data Package descriptor declares a resource schema with typed
fields. The adapter maps it like CSVW but uses JSON Table Schema vocabulary:

| Data Package property              | Maps to                          |
|------------------------------------|----------------------------------|
| `resources[].schema.fields[].name` | Column name                      |
| `resources[].schema.fields[].type` | Measure if `number`/`integer` (or named `value`) |
| `resources[].schema.fields[].rdfType` (IRI ending in `#time` / `#geo`) | Role |
| `resources[].schema.primaryKey`    | Dimension columns (if no explicit dims) |
| `resources[].schema.fields[].jsonstat:*` | Role / labels / units (round-trip extension) |

On export, `cubeToDataPackage` emits the inverse: a `fields[]` array where each
dimension field carries an `rdfType` derived from its role, the measure field
has `type: "number"`, and any JSON-stat-specific metadata (roles, valueForm,
extension) is preserved under `jsonstat:*` keys for a lossless round-trip. See
[`formats/datapackage.md`](./formats/datapackage.md) for the descriptor shape.

## Round-trip guarantee

The test suite verifies that `readDataset` (JSON-stat → IR) followed by `buildDataset` (IR → JSON-stat) reproduces the original dataset's values, dimensions, roles, and status. The same guarantee holds for `arrowToCube` → `cubeToArrow` on the Arrow side, for the text adapters (`csvToCube` → `cubeToCsv`, `csvwToCube` → `cubeToCsvw`, `datapackageToCube` → `cubeToDataPackage`), and for the full export round-trip: `exportDataset → bytes/text → importToDataset` returns the original dataset's values, dimensions, roles, and status. Any information loss in these round-trips is considered a bug.
