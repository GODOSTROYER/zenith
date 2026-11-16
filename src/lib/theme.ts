/** Shared by the pre-paint script and the client theme store. No runtime imports. */
export const THEME_STORAGE_KEY = "zenith-theme";
export const THEME_PREFERENCES = ["light", "dark", "amoled", "system"] as const;
export type Theme = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = Exclude<Theme, "system">;

function parsePreference(value: unknown, preferences: readonly string[]): Theme | null {
  return typeof value === "string" && preferences.includes(value) ? value as Theme : null;
}

export function parseTheme(value: unknown): Theme | null {
  return parsePreference(value, THEME_PREFERENCES);
}

/**
 * Keep this function self-contained: the head script embeds this exact source,
 * so a saved preference and an interactive change cannot resolve differently.
 * The missing data-theme attribute remains the existing Dark contract.
 */
export function applyTheme(theme: Theme): ResolvedTheme {
  let resolved: ResolvedTheme = theme === "system" ? "dark" : theme;
  if (theme === "system") {
    try {
      if (window.matchMedia?.("(prefers-color-scheme: light)").matches) resolved = "light";
    } catch {
      // Restricted or older browsers retain the product's dark fallback.
    }
  }
  const root = document.documentElement;
  root.setAttribute("data-theme-preference", theme);
  if (resolved === "dark") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", resolved);
  return resolved;
}

function bootstrapTheme(
  key: string,
  preferences: readonly string[],
  parse: typeof parsePreference,
  apply: typeof applyTheme,
) {
  let stored: string | null = null;
  try { stored = localStorage.getItem(key); } catch { /* Storage is optional. */ }
  // A new landing visit opens in porcelain; direct product visits open dark.
  apply(parse(stored, preferences) ?? (location.pathname === "/" ? "light" : "dark"));
}

/** Also usable before paint by a client-rendered root error boundary. */
export function initializeTheme(): void {
  const applied = parseTheme(document.documentElement.getAttribute("data-theme-preference"));
  if (applied) applyTheme(applied);
  else bootstrapTheme(THEME_STORAGE_KEY, THEME_PREFERENCES, parsePreference, applyTheme);
}

/** A synchronous head script: no network request and no hydration-time repaint. */
export const THEME_BOOTSTRAP_SCRIPT = `(${bootstrapTheme.toString()})(${JSON.stringify(THEME_STORAGE_KEY)},${JSON.stringify(THEME_PREFERENCES)},${parsePreference.toString()},${applyTheme.toString()});`;
