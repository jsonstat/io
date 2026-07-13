/**
 * Tests for the row-major index math — the correctness backbone.
 *
 * These are the most important tests in the suite: if the stride arithmetic
 * is wrong, every converter produces silently corrupt cubes. We verify
 * against hand-computed positions and round-trip (flatPosition ↔ multiIndex).
 */

import { describe, it, expect } from "vitest";
import {
  strides,
  totalCells,
  flatPosition,
  multiIndex,
  enumerateCells,
} from "../src/core/strides";

describe("strides", () => {
  it("computes row-major strides (last dimension changes fastest)", () => {
    // size [2,3,4]: stride[0]=12, stride[1]=4, stride[2]=1
    expect(strides([2, 3, 4])).toEqual([12, 4, 1]);
  });

  it("gives stride 1 for the last dimension", () => {
    expect(strides([5])[0]).toBe(1);
  });

  it("returns empty array for empty size", () => {
    expect(strides([])).toEqual([]);
  });

  it("computes strides for a single dimension", () => {
    expect(strides([7])).toEqual([1]);
  });
});

describe("totalCells", () => {
  it("multiplies all sizes", () => {
    expect(totalCells([2, 3, 4])).toBe(24);
  });

  it("returns 1 for empty (degenerate) size", () => {
    expect(totalCells([])).toBe(1);
  });
});

describe("flatPosition", () => {
  it("computes flat position for a 2×2 cube", () => {
    // id=[sex,year], size=[2,2], strides=[2,1]
    expect(flatPosition([0, 0], [2, 2])).toBe(0); // M, 2020
    expect(flatPosition([0, 1], [2, 2])).toBe(1); // M, 2021
    expect(flatPosition([1, 0], [2, 2])).toBe(2); // F, 2020
    expect(flatPosition([1, 1], [2, 2])).toBe(3); // F, 2021
  });

  it("computes flat position for a 3-dimension cube", () => {
    // size [2,3,4], strides [12,4,1]
    expect(flatPosition([0, 0, 0], [2, 3, 4])).toBe(0);
    expect(flatPosition([1, 2, 3], [2, 3, 4])).toBe(12 + 8 + 3); // = 23
    expect(flatPosition([0, 1, 2], [2, 3, 4])).toBe(4 + 2); // = 6
  });

  it("throws on length mismatch", () => {
    expect(() => flatPosition([0, 0], [2, 2, 2])).toThrow(/indices length/);
  });

  it("throws on out-of-range index", () => {
    expect(() => flatPosition([5, 0], [2, 2])).toThrow(/out of range/);
  });
});

describe("multiIndex", () => {
  it("is the inverse of flatPosition for 2×2", () => {
    const size = [2, 2];
    for (let pos = 0; pos < 4; pos++) {
      const idx = multiIndex(pos, size);
      expect(flatPosition(idx, size)).toBe(pos);
    }
  });

  it("is the inverse of flatPosition for 2×3×4", () => {
    const size = [2, 3, 4];
    const total = totalCells(size);
    for (let pos = 0; pos < total; pos++) {
      const idx = multiIndex(pos, size);
      expect(flatPosition(idx, size)).toBe(pos);
    }
  });

  it("throws on out-of-range position", () => {
    expect(() => multiIndex(4, [2, 2])).toThrow(/out of range/);
    expect(() => multiIndex(-1, [2, 2])).toThrow(/out of range/);
  });
});

describe("enumerateCells", () => {
  it("visits every cell exactly once in row-major order", () => {
    const size = [2, 3];
    const visited: number[] = [];
    enumerateCells(size, (_idx, pos) => visited.push(pos));
    expect(visited).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("yields incrementing multi-indices for the last dimension", () => {
    const size = [2, 2];
    const indices: number[][] = [];
    enumerateCells(size, (idx) => indices.push(idx));
    // Last dimension changes fastest.
    expect(indices).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
  });

  it("handles a single-cell cube", () => {
    const size = [1];
    const visited: number[] = [];
    enumerateCells(size, (_idx, pos) => visited.push(pos));
    expect(visited).toEqual([0]);
  });

  it("does nothing for a zero-size cube", () => {
    const visited: number[] = [];
    enumerateCells([0, 2], (_idx, pos) => visited.push(pos));
    expect(visited).toEqual([]);
  });
});
