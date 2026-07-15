/**
 * Tests for the CLI argument parser.
 *
 * These test the pure parsing functions in cli/args.ts — they don't spin up a
 * commander Program or touch the filesystem, making them fast and deterministic.
 */

import { describe, expect, it } from "vitest";
import {
  buildExportOptions,
  deriveDataPackageNamePath,
  parseCliOptions,
  parseDimensionsFlag,
  parseRoleFlag,
  parseThreshold,
  resolveValueForm,
} from "../src/cli/args";

// ---------------------------------------------------------------------------
// parseRoleFlag
// ---------------------------------------------------------------------------

describe("parseRoleFlag", () => {
  it("parses a single role assignment", () => {
    expect(parseRoleFlag("time=year")).toEqual({ time: ["year"] });
  });

  it("parses multiple role assignments", () => {
    expect(parseRoleFlag("time=year,geo=country,metric=value")).toEqual({
      time: ["year"],
      geo: ["country"],
      metric: ["value"],
    });
  });

  it("accumulates multiple columns under one role", () => {
    expect(parseRoleFlag("geo=country,geo=region")).toEqual({
      geo: ["country", "region"],
    });
  });

  it("returns undefined for empty input", () => {
    expect(parseRoleFlag(undefined)).toBeUndefined();
  });

  it("throws on invalid role name", () => {
    expect(() => parseRoleFlag("foo=bar")).toThrow(/Invalid --role "foo"/);
  });

  it("throws on missing column", () => {
    expect(() => parseRoleFlag("time=")).toThrow(/missing a column name/);
  });

  it("throws on malformed entry (no =)", () => {
    expect(() => parseRoleFlag("timeyear")).toThrow(/Invalid --role entry/);
  });
});

// ---------------------------------------------------------------------------
// parseDimensionsFlag
// ---------------------------------------------------------------------------

describe("parseDimensionsFlag", () => {
  it("parses a comma-separated list", () => {
    expect(parseDimensionsFlag("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("trims whitespace", () => {
    expect(parseDimensionsFlag(" a , b , c ")).toEqual(["a", "b", "c"]);
  });

  it("filters empty entries", () => {
    expect(parseDimensionsFlag("a,,b,")).toEqual(["a", "b"]);
  });

  it("returns undefined for no input", () => {
    expect(parseDimensionsFlag(undefined)).toBeUndefined();
  });

  it("throws when all entries are empty", () => {
    expect(() => parseDimensionsFlag(",,")).toThrow(/at least one/);
  });
});

// ---------------------------------------------------------------------------
// parseThreshold
// ---------------------------------------------------------------------------

describe("parseThreshold", () => {
  it("parses a valid number", () => {
    expect(parseThreshold("0.5")).toBe(0.5);
    expect(parseThreshold("0")).toBe(0);
    expect(parseThreshold("1")).toBe(1);
  });

  it("returns undefined for no input", () => {
    expect(parseThreshold(undefined)).toBeUndefined();
  });

  it("throws on non-numeric input", () => {
    expect(() => parseThreshold("abc")).toThrow(/between 0 and 1/);
  });

  it("throws on value > 1", () => {
    expect(() => parseThreshold("1.5")).toThrow(/between 0 and 1/);
  });

  it("throws on negative value", () => {
    expect(() => parseThreshold("-0.1")).toThrow(/between 0 and 1/);
  });
});

// ---------------------------------------------------------------------------
// resolveValueForm
// ---------------------------------------------------------------------------

describe("resolveValueForm", () => {
  it("returns sparse when --sparse is set", () => {
    expect(resolveValueForm({ sparse: true })).toBe("sparse");
  });

  it("returns dense when --dense is set", () => {
    expect(resolveValueForm({ dense: true })).toBe("dense");
  });

  it("returns auto when neither is set", () => {
    expect(resolveValueForm({})).toBe("auto");
  });

  it("sparse wins over dense when both are set", () => {
    expect(resolveValueForm({ sparse: true, dense: true })).toBe("sparse");
  });
});

// ---------------------------------------------------------------------------
// parseCliOptions (integration)
// ---------------------------------------------------------------------------

describe("parseCliOptions", () => {
  it("parses minimal options with defaults", () => {
    const result = parseCliOptions({});
    expect(result.importOptions.from).toBe("auto");
    expect(result.validate).toBe(false);
    expect(result.pretty).toBe(true);
    expect(result.canonicalKeys).toBe(true);
    expect(result.buildOptions.valueForm).toBe("auto");
  });

  it("passes --from through", () => {
    const result = parseCliOptions({ from: "parquet" });
    expect(result.importOptions.from).toBe("parquet");
  });

  it("throws on unsupported --from value", () => {
    expect(() => parseCliOptions({ from: "xml" })).toThrow(/not supported/);
  });

  it("defaults --to to jsonstat (import direction)", () => {
    expect(parseCliOptions({}).to).toBe("jsonstat");
  });

  it("accepts export --to targets", () => {
    for (const target of ["arrow", "parquet", "csv", "csvw"]) {
      expect(parseCliOptions({ to: target }).to).toBe(target);
    }
  });

  it("throws on unsupported --to value", () => {
    expect(() => parseCliOptions({ to: "xml" })).toThrow(/not supported/);
  });

  it("passes --measure and --dimensions through", () => {
    const result = parseCliOptions({
      measure: "value",
      dimensions: "sex,year",
    });
    expect(result.importOptions.measure).toBe("value");
    expect(result.importOptions.dimensions).toEqual(["sex", "year"]);
  });

  it("passes --role through as parsed roles", () => {
    const result = parseCliOptions({ role: "time=year,geo=country" });
    expect(result.importOptions.roles).toEqual({
      time: ["year"],
      geo: ["country"],
    });
  });

  it("passes --sparse as valueForm", () => {
    const result = parseCliOptions({ sparse: true });
    expect(result.buildOptions.valueForm).toBe("sparse");
  });

  it("passes --threshold through", () => {
    const result = parseCliOptions({ threshold: "0.3" });
    expect(result.buildOptions.sparseThreshold).toBe(0.3);
  });

  it("passes --label/--source/--updated as dataset metadata", () => {
    const result = parseCliOptions({
      label: "My Dataset",
      source: "Me",
      updated: "2024-01-01",
    });
    expect(result.buildOptions.meta).toEqual({
      label: "My Dataset",
      source: "Me",
      updated: "2024-01-01",
    });
  });

  it("passes --validate flag", () => {
    const result = parseCliOptions({ validate: true });
    expect(result.validate).toBe(true);
  });

  it("passes --output flag", () => {
    const result = parseCliOptions({ output: "out.json" });
    expect(result.output).toBe("out.json");
  });

  it("respects --no-pretty", () => {
    const result = parseCliOptions({ noPretty: true });
    expect(result.pretty).toBe(false);
  });

  it("respects --no-canonical-keys", () => {
    const result = parseCliOptions({ noCanonicalKeys: true });
    expect(result.canonicalKeys).toBe(false);
  });

  it("passes --status-form through", () => {
    const result = parseCliOptions({ statusForm: "object" });
    expect(result.buildOptions.statusForm).toBe("object");
  });

  it("throws on invalid --status-form", () => {
    expect(() => parseCliOptions({ statusForm: "invalid" })).toThrow(/invalid/);
  });

  it("parses --csvw-metadata as JSON", () => {
    const result = parseCliOptions({
      csvwMetadata: '{"url":"meta.json"}',
    });
    expect(result.importOptions.csvwMetadata).toEqual({ url: "meta.json" });
  });

  it("throws on invalid --csvw-metadata JSON", () => {
    expect(() => parseCliOptions({ csvwMetadata: "{not json" })).toThrow(/valid JSON/);
  });

  it("does not create empty meta object when no metadata flags given", () => {
    const result = parseCliOptions({});
    expect(result.buildOptions.meta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deriveDataPackageNamePath / buildExportOptions
// ---------------------------------------------------------------------------

describe("deriveDataPackageNamePath", () => {
  it("derives name and path from a simple CSV output", () => {
    expect(deriveDataPackageNamePath("cube.csv")).toEqual({
      datapackageName: "cube",
      datapackagePath: "cube.csv",
    });
  });

  it("uses only the basename for path (descriptor is a CSV sibling)", () => {
    expect(deriveDataPackageNamePath("data/sub/cube.csv")).toEqual({
      datapackageName: "cube",
      datapackagePath: "cube.csv",
    });
  });

  it("handles Windows-style separators", () => {
    expect(deriveDataPackageNamePath("data\\sub\\cube.csv")).toEqual({
      datapackageName: "cube",
      datapackagePath: "cube.csv",
    });
  });

  it("slugifies a non-slug stem", () => {
    expect(deriveDataPackageNamePath("My Cube.csv")).toEqual({
      datapackageName: "my-cube",
      datapackagePath: "My Cube.csv",
    });
  });

  it("returns empty object when output is absent", () => {
    expect(deriveDataPackageNamePath(undefined)).toEqual({});
  });

  it("returns empty object when output is '-' (stdout)", () => {
    expect(deriveDataPackageNamePath("-")).toEqual({});
  });

  it("handles an extensionless output", () => {
    expect(deriveDataPackageNamePath("cube")).toEqual({
      datapackageName: "cube",
      datapackagePath: "cube",
    });
  });
});

describe("buildExportOptions", () => {
  it("forwards delimiter/decimal/unitSep", () => {
    const opts = buildExportOptions({
      delimiter: ";",
      decimal: ",",
      unitSep: "#",
    });
    expect(opts.delimiter).toBe(";");
    expect(opts.decimal).toBe(",");
    expect(opts.unitSep).toBe("#");
  });

  it("derives datapackage name/path from -o", () => {
    const opts = buildExportOptions({ output: "cube.csv" });
    expect(opts.datapackageName).toBe("cube");
    expect(opts.datapackagePath).toBe("cube.csv");
  });

  it("leaves datapackage name/path undefined without -o", () => {
    const opts = buildExportOptions({});
    expect(opts.datapackageName).toBeUndefined();
    expect(opts.datapackagePath).toBeUndefined();
  });

  it("leaves datapackage name/path undefined for stdout (-)", () => {
    const opts = buildExportOptions({ output: "-" });
    expect(opts.datapackageName).toBeUndefined();
    expect(opts.datapackagePath).toBeUndefined();
  });

  it("normalizes --line-terminator escape sequences", () => {
    expect(buildExportOptions({ lineTerminator: "\\n" }).lineTerminator).toBe("\n");
    expect(buildExportOptions({ lineTerminator: "\\r\\n" }).lineTerminator).toBe("\r\n");
    expect(buildExportOptions({ lineTerminator: "lf" }).lineTerminator).toBe("\n");
    expect(buildExportOptions({ lineTerminator: "crlf" }).lineTerminator).toBe("\r\n");
  });

  it("passes an unknown line terminator through verbatim", () => {
    expect(buildExportOptions({ lineTerminator: "XX" }).lineTerminator).toBe("XX");
  });

  it("is reachable through parseCliOptions", () => {
    const result = parseCliOptions({ to: "datapackage", output: "cube.csv" });
    expect(result.exportOptions.datapackageName).toBe("cube");
    expect(result.exportOptions.datapackagePath).toBe("cube.csv");
  });
});
