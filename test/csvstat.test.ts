/**
 * Tests for the CSV-stat (JSV) adapter: import (`csvstatToCube`),
 * export (`cubeToCsvstat`), round-trip fidelity, and format detection.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDataset } from "../src/core/cubeBuilder";
import { readDataset } from "../src/core/cubeReader";
import type { JsonStatDataset } from "../src/model/jsonstat";
import { csvstatToCube, cubeToCsvstat } from "../src/sources/csvstat";
import { detectFromBytes, detectFromExtension } from "../src/util/detect";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GALICIA_PATH = resolve(__dirname, "../.idea/galicia.jsv");

/** Read a tiny JSV text fixture. */
const MINI_JSV = [
  "jsonstat,.,|",
  "label,Unemployment rate",
  "source,OECD",
  "updated,2012-11-27",
  "href,https://json-stat.org/samples/oecd.json",
  "dimension,sex,gender,3,T,total,M,male,F,female",
  "dimension,year,year,2,2001,2001,2011,2011,time",
  "dimension,concept,concept,1,pop,population,metric,0|persons",
  "data",
  "sex,year,concept,value",
  "T,2001,pop,100",
  "T,2011,pop,200",
  "M,2001,pop,30",
  "M,2011,pop,60",
  "F,2001,pop,70",
  "F,2011,pop,140",
].join("\r\n");

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

describe("CSV-stat import (csvstatToCube)", () => {
  it("parses the metadata header into the IR model", () => {
    const obs = csvstatToCube(MINI_JSV);
    expect(obs.model.dimensionIds).toEqual(["sex", "year", "concept"]);
    expect(obs.model.meta?.label).toBe("Unemployment rate");
    expect(obs.model.meta?.source).toBe("OECD");
    expect(obs.model.meta?.updated).toBe("2012-11-27");
    expect(obs.model.meta?.href).toBe("https://json-stat.org/samples/oecd.json");
    // Roles inferred from the dimension lines.
    expect(obs.model.roles).toEqual({ time: ["year"], metric: ["concept"] });
  });

  it("preserves category order, labels and units from dimension lines", () => {
    const obs = csvstatToCube(MINI_JSV);
    const sex = obs.dimensions.sex;
    expect(sex.categoryOrder).toEqual(["T", "M", "F"]);
    expect(sex.categoryLabels).toEqual({ T: "total", M: "male", F: "female" });
    expect(sex.label).toBe("gender");
    const concept = obs.dimensions.concept;
    expect(concept.categoryUnits).toEqual({
      pop: { decimals: 0, label: "persons" },
    });
  });

  it("maps non-numeric value cells to null (missing observations)", () => {
    const jsv = [
      "jsonstat,.,|",
      "dimension,x,x,2,a,a,b,b",
      "dimension,m,m,1,v,value",
      "data",
      "x,m,value",
      "a,v,5",
      "b,v,n/a",
    ].join("\r\n");
    const obs = csvstatToCube(jsv);
    expect(obs.measure.values).toEqual([5, null]);
  });

  it("honors a custom decimal delimiter from the jsonstat line", () => {
    // A locale using comma decimals must pair it with a non-comma column
    // delimiter (here ";"); otherwise the decimal mark is ambiguous.
    const jsv = [
      "jsonstat;,;|",
      "dimension;x;x;2;a;a;b;b",
      "dimension;m;m;1;v;value",
      "data",
      "x;m;value",
      "a;v;1,5",
      "b;v;2,5",
    ].join("\r\n");
    const obs = csvstatToCube(jsv, { delimiter: ";" });
    expect(obs.measure.values).toEqual([1.5, 2.5]);
  });

  it("parses a status column when present immediately before value", () => {
    const jsv = [
      "jsonstat,.,|",
      "dimension,x,x,2,a,a,b,b",
      "dimension,m,m,1,v,value",
      "data",
      "x,m,status,value",
      "a,v,,5",
      "b,v,e,6",
    ].join("\r\n");
    const obs = csvstatToCube(jsv);
    expect(obs.status?.values).toEqual(["", "e"]);
    expect(obs.measure.values).toEqual([5, 6]);
  });

  it("throws on a missing data line", () => {
    const jsv = ["jsonstat,.,|", "dimension,x,x,1,a,a"].join("\r\n");
    expect(() => csvstatToCube(jsv)).toThrow(/data/);
  });

  it("throws when the first line is not a jsonstat line", () => {
    expect(() => csvstatToCube("a,b,c\n1,2,3")).toThrow(/jsonstat/);
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("CSV-stat export (cubeToCsvstat)", () => {
  it("emits a complete JSV text with header, dimensions and records", () => {
    const obs = csvstatToCube(MINI_JSV);
    const out = cubeToCsvstat(obs);
    const lines = out.split("\r\n");
    expect(lines[0]).toBe("jsonstat,.,|");
    expect(lines[1]).toBe("label,Unemployment rate");
    expect(lines[2]).toBe("source,OECD");
    expect(lines[3]).toBe("updated,2012-11-27");
    expect(lines[4]).toBe("href,https://json-stat.org/samples/oecd.json");
    // Dimension lines carry id/label/size, category id/label, role, units.
    const sexLine = lines.find((l) => l.startsWith("dimension,sex"));
    expect(sexLine).toBe("dimension,sex,gender,3,T,total,M,male,F,female");
    const yearLine = lines.find((l) => l.startsWith("dimension,year"));
    expect(yearLine).toBe("dimension,year,year,2,2001,2001,2011,2011,time");
    const conceptLine = lines.find((l) => l.startsWith("dimension,concept"));
    expect(conceptLine).toBe("dimension,concept,concept,1,pop,population,metric,0|persons");
    // data marker + CSV header.
    expect(lines).toContain("data");
    expect(lines).toContain("sex,year,concept,value");
    // Records are present.
    expect(out).toContain("T,2001,pop,100");
    expect(out).toContain("F,2011,pop,140");
  });

  it("emits empty value cells for null measures", () => {
    const jsv = [
      "jsonstat,.,|",
      "dimension,x,x,2,a,a,b,b",
      "dimension,m,m,1,v,value",
      "data",
      "x,m,value",
      "a,v,5",
      "b,v,n/a",
    ].join("\r\n");
    const obs = csvstatToCube(jsv);
    const out = cubeToCsvstat(obs);
    expect(out).toContain("a,v,5");
    expect(out).toContain("b,v,");
  });

  it("applies a custom decimal delimiter on export", () => {
    const obs = csvstatToCube(MINI_JSV);
    // Pair comma decimals with a ";" column delimiter (realistic locale).
    const out = cubeToCsvstat(obs, {
      delimiter: ";",
      decimal: ",",
      unitSep: "|",
    });
    expect(out.split("\r\n")[0]).toBe("jsonstat;,;|");
    expect(out).toContain("T;2001;pop;100");
  });

  it("quotes fields containing the delimiter", () => {
    const obs = csvstatToCube(MINI_JSV);
    // The label has no comma, but the source/URL are fine; force a quoted check
    // by re-exporting with a label that contains a comma.
    obs.model.meta = { label: "Hello, World" };
    const out2 = cubeToCsvstat(obs);
    expect(out2).toContain('label,"Hello, World"');
  });
});

// ---------------------------------------------------------------------------
// Round-trip: JSV → dataset → JSV (stable)
// ---------------------------------------------------------------------------

describe("CSV-stat round-trip", () => {
  it("import → build → read → export is byte-stable for a mini-JSV", () => {
    const obs = csvstatToCube(MINI_JSV, { valueForm: "dense" });
    const { dataset } = buildDataset(obs, { valueForm: "dense" });
    const obs2 = readDataset(dataset, { dropNulls: false });
    const out = cubeToCsvstat(obs2);
    expect(out).toBe(`${MINI_JSV}\r\n`);
  });

  // galicia.jsv is a local-only (gitignored under .idea/) fixture derived from
  // the canonical OECD JSON-stat sample. Skip when absent so CI/publish are not
  // blocked; the test runs when a developer has the fixture locally.
  it.skipIf(!existsSync(GALICIA_PATH))(
    "round-trips the canonical galicia.jsv sample without loss",
    () => {
      const original = readFileSync(GALICIA_PATH, "utf8");
      // galicia.jsv uses LF line endings; normalize to CRLF for round-trip
      // stability (our writer emits CRLF by default).
      const normalized = original.replace(/\r\n/g, "\n");
      const obs = csvstatToCube(normalized, { valueForm: "dense" });
      const { dataset } = buildDataset(obs, { valueForm: "dense" });
      const obs2 = readDataset(dataset, { dropNulls: false });
      const out = cubeToCsvstat(obs2);

      // Re-import the exported text and compare the materialized datasets.
      const roundTripped = csvstatToCube(out.replace(/\r\n/g, "\n"), {
        valueForm: "dense",
      });
      const { dataset: rebuilt2 } = buildDataset(roundTripped, {
        valueForm: "dense",
      });
      expect(rebuilt2.id).toEqual(dataset.id);
      expect(rebuilt2.size).toEqual(dataset.size);
      // Materialized values must match exactly.
      const total = dataset.size!.reduce((p, s) => p * s, 1);
      const a = materialize(dataset.value, total);
      const b = materialize(rebuilt2.value, total);
      expect(b).toEqual(a);
      // Category order must be preserved per dimension.
      for (const dimId of dataset.id!) {
        const idxA = dataset.dimension[dimId].category?.index;
        const idxB = rebuilt2.dimension[dimId].category?.index;
        if (idxA && idxB) {
          const arrA = Array.isArray(idxA)
            ? idxA
            : Object.keys(idxA).sort((x, y) => idxA[x] - idxA[y]);
          const arrB = Array.isArray(idxB)
            ? idxB
            : Object.keys(idxB).sort((x, y) => idxB[x] - idxB[y]);
          expect(arrB).toEqual(arrA);
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe("CSV-stat detection", () => {
  it("detects the jsv format from the jsonstat, magic prefix", () => {
    const bytes = new TextEncoder().encode("jsonstat,.,|\nlabel,x");
    expect(detectFromBytes(bytes)).toBe("jsv");
  });

  it("detects the jsv format from the .jsv and .csvstat extensions", () => {
    expect(detectFromExtension("jsv")).toBe("jsv");
    expect(detectFromExtension("csvstat")).toBe("jsv");
    expect(detectFromExtension("csv-stat")).toBe("jsv");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function materialize(value: JsonStatDataset["value"], total: number): (number | null)[] {
  if (Array.isArray(value)) return value;
  const dense = new Array(total).fill(null);
  for (const [k, v] of Object.entries(value)) {
    dense[Number(k)] = v;
  }
  return dense;
}
