/**
 * Tests for the utility modules: format detection (detect.ts) and density
 * decision (density.ts), plus the serializer (serialize.ts).
 */

import { describe, expect, it } from "vitest";
import { serialize } from "../src/sink/serialize";
import { csvToCube } from "../src/sources/csv";
import { csvwToCube, parseCsvwMetadata } from "../src/sources/csvw";
import { decideDensity } from "../src/util/density";
import {
  detectFormat,
  detectFromBytes,
  detectFromExtension,
  extensionOf,
} from "../src/util/detect";
import { simpleDataset } from "./fixtures";

// ---------------------------------------------------------------------------
// detect.ts
// ---------------------------------------------------------------------------

describe("detectFromBytes", () => {
  it("detects Arrow IPC by the ARROW1 magic bytes", () => {
    const arrowBytes = new Uint8Array([
      0x41,
      0x52,
      0x52,
      0x4f,
      0x57,
      0x31,
      0x00,
      0x00, // "ARROW1\0\0"
    ]);
    expect(detectFromBytes(arrowBytes)).toBe("arrow");
  });

  it("detects Parquet by the PAR1 magic bytes", () => {
    const parquetBytes = new Uint8Array([0x50, 0x41, 0x52, 0x31]); // "PAR1"
    expect(detectFromBytes(parquetBytes)).toBe("parquet");
  });

  it("detects JSON-stat when JSON contains class + version", () => {
    const jsonBytes = new TextEncoder().encode('{"version":"2.0","class":"dataset"}');
    expect(detectFromBytes(jsonBytes)).toBe("jsonstat");
  });

  it("detects generic JSON when no class/version markers", () => {
    const jsonBytes = new TextEncoder().encode('{"foo":"bar","baz":[1,2]}');
    expect(detectFromBytes(jsonBytes)).toBe("json");
  });

  it("detects CSV when it starts with a non-JSON, non-binary text", () => {
    const csvBytes = new TextEncoder().encode("a,b,c\n1,2,3");
    expect(detectFromBytes(csvBytes)).toBe("csv");
  });
});

describe("detectFromExtension", () => {
  it("maps .parquet → parquet", () => {
    expect(detectFromExtension("parquet")).toBe("parquet");
  });

  it("maps .arrow / .feather → arrow", () => {
    expect(detectFromExtension("arrow")).toBe("arrow");
    expect(detectFromExtension("feather")).toBe("arrow");
  });

  it("maps .json → jsonstat (default assumption for JSON files)", () => {
    expect(detectFromExtension("json")).toBe("jsonstat");
  });

  it("maps .json-stat → jsonstat", () => {
    expect(detectFromExtension("json-stat")).toBe("jsonstat");
  });

  it("maps .csvw → csvw", () => {
    expect(detectFromExtension("csvw")).toBe("csvw");
  });

  it("maps .csv → csv", () => {
    expect(detectFromExtension("csv")).toBe("csv");
  });

  it("returns 'unknown' for unrecognized extensions", () => {
    expect(detectFromExtension("xyz")).toBe("unknown");
  });
});

describe("extensionOf", () => {
  it("extracts the extension from a file path", () => {
    expect(extensionOf("data/file.parquet")).toBe("parquet");
    expect(extensionOf("/abs/path/to/data.arrow")).toBe("arrow");
  });

  it("extracts the extension from a URL", () => {
    expect(extensionOf("https://example.com/data.json")).toBe("json");
  });

  it("returns undefined for no extension", () => {
    expect(extensionOf("README")).toBeUndefined();
  });

  it("handles query strings in URLs", () => {
    expect(extensionOf("https://example.com/data.csv?foo=bar")).toBe("csv");
  });
});

describe("detectFormat", () => {
  it("prefers the extension when available", () => {
    expect(detectFormat("data.parquet", undefined)).toBe("parquet");
  });

  it("falls back to byte sniffing when extension is unknown", () => {
    const arrowBytes = new Uint8Array([0x41, 0x52, 0x52, 0x4f, 0x57, 0x31, 0x00, 0x00]);
    expect(detectFormat("file-with-no-ext", arrowBytes)).toBe("arrow");
  });

  it("falls back to byte sniffing when no path is given", () => {
    const arrowBytes = new Uint8Array([0x41, 0x52, 0x52, 0x4f, 0x57, 0x31, 0x00, 0x00]);
    expect(detectFormat(undefined, arrowBytes)).toBe("arrow");
  });

  it("returns unknown when nothing is available", () => {
    expect(detectFormat(undefined, undefined)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// density.ts
// ---------------------------------------------------------------------------

describe("decideDensity", () => {
  it("chooses dense when null ratio is below threshold", () => {
    const result = decideDensity([1, 2, 3, 4], "auto");
    expect(result.form).toBe("dense");
    expect(result.nullRatio).toBe(0);
  });

  it("chooses sparse when null ratio exceeds default threshold (0.5)", () => {
    const result = decideDensity([1, null, null, null], "auto");
    expect(result.form).toBe("sparse");
    expect(result.nullRatio).toBe(0.75);
  });

  it("honors a custom threshold", () => {
    const result = decideDensity([1, null, 3, 4], "auto", { threshold: 0.1 });
    expect(result.form).toBe("sparse");
  });

  it("respects explicit dense request regardless of null ratio", () => {
    const result = decideDensity([null, null, null, null], "dense");
    expect(result.form).toBe("dense");
  });

  it("respects explicit sparse request regardless of null ratio", () => {
    const result = decideDensity([1, 2, 3, 4], "sparse");
    expect(result.form).toBe("sparse");
  });

  it("counts nulls correctly", () => {
    const result = decideDensity([1, null, 3, null, 5]);
    expect(result.nullCount).toBe(2);
    expect(result.total).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// serialize.ts
// ---------------------------------------------------------------------------

describe("serialize", () => {
  it("produces valid JSON", () => {
    const json = serialize(simpleDataset());
    const parsed = JSON.parse(json);
    expect(parsed.class).toBe("dataset");
  });

  it("pretty-prints by default (2-space indent)", () => {
    const json = serialize(simpleDataset());
    expect(json).toContain('\n  "version"');
  });

  it("produces compact JSON when pretty is false", () => {
    const json = serialize(simpleDataset(), { pretty: false });
    expect(json).not.toContain("\n");
  });

  it("orders keys canonically when canonicalKeys is true", () => {
    const json = serialize(simpleDataset(), { canonicalKeys: true });
    const versionIdx = json.indexOf('"version"');
    const classIdx = json.indexOf('"class"');
    const idIdx = json.indexOf('"id"');
    // version should come before class, which should come before id.
    expect(versionIdx).toBeLessThan(classIdx);
    expect(classIdx).toBeLessThan(idIdx);
  });

  it("preserves all required fields", () => {
    const ds = simpleDataset();
    const json = serialize(ds);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe("2.0");
    expect(parsed.id).toEqual(ds.id);
    expect(parsed.size).toEqual(ds.size);
    expect(parsed.value).toEqual(ds.value);
  });
});

// ---------------------------------------------------------------------------
// Default-measure="value" rule (CSV + CSVW)
// ---------------------------------------------------------------------------

describe("default-measure value rule (csvToCube)", () => {
  it("treats a column named 'value' as the measure without --measure", () => {
    const csv = "year,geo,value\n2020,ES,100\n2021,FR,200";
    const obs = csvToCube(csv);
    expect(obs.measure.name).toBe("value");
    expect(obs.measure.values).toEqual([100, 200]);
    expect(obs.model.dimensionIds).toEqual(["year", "geo"]);
  });

  it("matches 'value' case-insensitively", () => {
    const csv = "year,geo,VALUE\n2020,ES,1\n";
    const obs = csvToCube(csv);
    expect(obs.measure.name).toBe("VALUE");
  });

  it("falls back to numeric inference when no 'value' column exists", () => {
    // Categorical (non-numeric) dimensions, so 'amount' is the first and only
    // all-numeric column.
    const csv = "country,product,amount\nES,A,100\nFR,B,200";
    const obs = csvToCube(csv);
    expect(obs.measure.name).toBe("amount");
  });

  it("honors an explicit options.measure over the 'value' default", () => {
    const csv = "year,geo,value,amount\n2020,ES,1,100\n2021,FR,2,200";
    const obs = csvToCube(csv, { measure: "amount" });
    expect(obs.measure.name).toBe("amount");
    // 'value' is now a dimension.
    expect(obs.model.dimensionIds).toContain("value");
  });
});

describe("default-measure value rule (csvwToCube)", () => {
  it("treats a field named 'value' as the measure even without a numeric datatype", () => {
    const csv = "year,value\n2020,1\n2021,2";
    const meta = parseCsvwMetadata({
      tableSchema: {
        columns: [
          { name: "year", titles: "year", datatype: "string" },
          { name: "value", titles: "value", datatype: "string" },
        ],
        primaryKey: ["year"],
      },
    });
    const obs = csvwToCube(csv, meta);
    expect(obs.measure.name).toBe("value");
    expect(obs.model.dimensionIds).toEqual(["year"]);
  });

  it("falls back to numeric-datatype detection when no 'value' field exists", () => {
    const csv = "year,amount\n2020,1\n2021,2";
    const meta = parseCsvwMetadata({
      tableSchema: {
        columns: [
          { name: "year", titles: "year", datatype: "string" },
          { name: "amount", titles: "amount", datatype: "decimal" },
        ],
        primaryKey: ["year"],
      },
    });
    const obs = csvwToCube(csv, meta);
    expect(obs.measure.name).toBe("amount");
  });
});
