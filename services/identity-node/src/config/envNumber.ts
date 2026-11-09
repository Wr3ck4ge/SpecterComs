/**
 * A numeric env override that can't silently disable a check. `Number('80%')`
 * is NaN, and `x >= NaN` is always false, so a typo used to turn an alert or a
 * liveness window off without a word (eval L3). An invalid or out-of-range
 * value now logs once and falls back to the default.
 */
export function envNumber(name: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  const { min = -Infinity, max = Infinity } = opts;
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`[config] ${name}=${JSON.stringify(raw)} is not a number in [${min}, ${max}]; using the default ${fallback}`);
    return fallback;
  }
  return n;
}
