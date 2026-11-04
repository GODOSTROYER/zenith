/** Attribute path helpers: `a.b[0].c` and `a.b[].c` compare equal; a parent path covers its children. */

export function normalizePath(path: string): string {
  return path.trim().replace(/\[\d+\]/g, "[]").replace(/\.{2,}/g, ".").replace(/^\./, "");
}

/** Whether `pattern` covers `path` (equal, or `path` is a descendant of `pattern`). */
export function pathCovers(pattern: string, path: string): boolean {
  const p = normalizePath(pattern);
  const a = normalizePath(path);
  if (p === a) return true;
  return a.startsWith(p) && (a[p.length] === "." || a[p.length] === "[");
}
