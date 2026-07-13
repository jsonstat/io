/**
 * Density helper — sparse vs dense `value` decision.
 *
 * Centralizes the null-ratio threshold logic so the cube builder and tests
 * share one definition. See wiki/sparse-cubes.md for the rationale: the object
 * (sparse) form is preferred when many cells are null.
 */

export interface DensityResult {
  form: "dense" | "sparse";
  nullRatio: number;
  nullCount: number;
  total: number;
}

export interface DensityOptions {
  /** Null ratio above which "auto" chooses sparse. Default 0.5. */
  threshold?: number;
}

/**
 * Decide dense vs sparse for a flat value array.
 *
 * @param values The dense row-major array (with nulls).
 * @param requested "auto" | "dense" | "sparse".
 */
export function decideDensity(
  values: (number | null)[],
  requested: "auto" | "dense" | "sparse" = "auto",
  options: DensityOptions = {},
): DensityResult {
  const total = values.length;
  const threshold = options.threshold ?? 0.5;
  let nullCount = 0;
  for (const v of values) {
    if (v === null) nullCount++;
  }
  const nullRatio = total === 0 ? 0 : nullCount / total;

  let form: "dense" | "sparse";
  if (requested === "dense") form = "dense";
  else if (requested === "sparse") form = "sparse";
  else form = nullRatio > threshold ? "sparse" : "dense";

  return { form, nullRatio, nullCount, total };
}
