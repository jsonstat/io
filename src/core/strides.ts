/**
 * Row-major index math — the correctness backbone of the importer.
 *
 * JSON-stat stores cell values in a flat array laid out in **row-major order**,
 * described by the spec as "what does not change, first": the *last* dimension
 * in `id` changes fastest (see https://jsonstat.org/format/).
 *
 * Concretely, for dimensions with sizes `s₀, s₁, …, sₖ₋₁`, the flat position of
 * a cell at multi-index `(i₀, i₁, …, iₖ₋₁)` is:
 *
 *     pos = i₀·(s₁·…·sₖ₋₁) + i₁·(s₂·…·sₖ₋₁) + … + iₖ₋₂·sₖ₋₁ + iₖ₋₁
 *
 * i.e. the stride of dimension `d` is the product of the sizes of all
 * dimensions that come *after* it. This module centralizes that arithmetic so
 * every converter and the round-trip tests share one source of truth.
 */

/** Compute row-major strides from a `size` array. strides[d] = ∏ size[d+1..]. */
export function strides(size: number[]): number[] {
  const out = new Array<number>(size.length);
  let acc = 1;
  // Walk right-to-left so each stride is the running product of later sizes.
  for (let d = size.length - 1; d >= 0; d--) {
    out[d] = acc;
    acc *= size[d];
  }
  return out;
}

/** Total number of cells = product of all sizes (the dense cell count). */
export function totalCells(size: number[]): number {
  return size.reduce((a, b) => a * b, 1);
}

/**
 * Convert a multi-index to a flat row-major position.
 *
 * `indices` length must equal `size` length; each `indices[d]` must satisfy
 * `0 ≤ indices[d] < size[d]`.
 */
export function flatPosition(indices: number[], size: number[]): number {
  if (indices.length !== size.length) {
    throw new Error(
      `flatPosition: indices length ${indices.length} !== size length ${size.length}`,
    );
  }
  const s = strides(size);
  let pos = 0;
  for (let d = 0; d < indices.length; d++) {
    const i = indices[d];
    if (i < 0 || i >= size[d]) {
      throw new Error(
        `flatPosition: index ${i} out of range [0,${size[d]}) for dimension ${d}`,
      );
    }
    pos += i * s[d];
  }
  return pos;
}

/**
 * Inverse of [`flatPosition`](#flatposition): decompose a flat position back
 * into a multi-index. Used by the cube reader (Phase-2 seam) and by tests.
 */
export function multiIndex(pos: number, size: number[]): number[] {
  const s = strides(size);
  const total = totalCells(size);
  if (pos < 0 || pos >= total) {
    throw new Error(`multiIndex: position ${pos} out of range [0,${total})`);
  }
  const out = new Array<number>(size.length);
  let rem = pos;
  for (let d = 0; d < size.length; d++) {
    out[d] = Math.floor(rem / s[d]);
    rem = rem % s[d];
  }
  return out;
}

/**
 * Enumerate every multi-index in row-major order, yielding flat positions
 * 0..(total-1). Useful for materializing a dense value array from a sparse map.
 *
 * Calls `visit(indices, flatPos)` for each cell. Iterative (no recursion) to
 * avoid stack overflow on large cubes.
 */
export function enumerateCells(
  size: number[],
  visit: (indices: number[], flatPos: number) => void,
): void {
  const k = size.length;
  const total = totalCells(size);
  if (total === 0) return;
  const idx = new Array<number>(k).fill(0);
  for (let pos = 0; pos < total; pos++) {
    visit(idx.slice(), pos);
    // Increment the last dimension first (it changes fastest), carrying over.
    for (let d = k - 1; d >= 0; d--) {
      idx[d]++;
      if (idx[d] < size[d]) break;
      idx[d] = 0; // carry
    }
  }
}
