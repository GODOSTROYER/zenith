/** Environment comparisons preserve explicit source → target direction. */
export function orderComparison<T extends { number: number }>(a: T, b: T, directional: boolean): [T, T] {
  return directional || a.number <= b.number ? [a, b] : [b, a];
}
