/** Averages a long series down to at most `n` samples, keeping gaps where a whole bucket had none. */
export function downsample(values: (number | null)[], n: number): (number | null)[] {
  if (values.length <= n) return values
  const out: (number | null)[] = []
  for (let i = 0; i < n; i++) {
    const bucket = values.slice(Math.floor((i * values.length) / n), Math.floor(((i + 1) * values.length) / n)).filter((v): v is number => v != null)
    out.push(bucket.length ? bucket.reduce((a, b) => a + b, 0) / bucket.length : null)
  }
  return out
}

/** A round top for a scale: 1, 2 or 5 times a power of ten. */
export function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  const n = v / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
}
