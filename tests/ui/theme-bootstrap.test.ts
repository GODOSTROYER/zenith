import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { THEME_BOOTSTRAP_SCRIPT, THEME_STORAGE_KEY } from "@/lib/theme";

/** Execute the actual head script before any React/client store has mounted. */
function bootstrap({
  preference = null,
  pathname = "/overview",
  light = false,
  storageFails = false,
  media = "available",
}: {
  preference?: string | null;
  pathname?: string;
  light?: boolean;
  storageFails?: boolean;
  media?: "available" | "missing" | "throws";
} = {}) {
  const attributes = new Map<string, string>();
  runInNewContext(THEME_BOOTSTRAP_SCRIPT, {
    document: { documentElement: {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    } },
    location: { pathname },
    localStorage: { getItem: (key: string) => {
      expect(key).toBe(THEME_STORAGE_KEY);
      if (storageFails) throw new Error("Storage blocked");
      return preference;
    } },
    window: { matchMedia: media === "missing" ? undefined : (query: string) => {
      expect(query).toBe("(prefers-color-scheme: light)");
      if (media === "throws") throw new Error("Media unavailable");
      return { matches: light };
    } },
  });
  return { resolved: attributes.get("data-theme") ?? "dark", preference: attributes.get("data-theme-preference") };
}

describe("theme before first paint", () => {
  it.each(["light", "dark", "amoled"])("applies saved %s independently of route and OS", (preference) => {
    for (const pathname of ["/", "/login", "/overview", "/p/example/navigator"])
      for (const light of [false, true])
        expect(bootstrap({ preference, pathname, light })).toEqual({ resolved: preference, preference });
  });

  it.each([false, true])("resolves System from the OS when prefers-light is %s", (light) => {
    expect(bootstrap({ preference: "system", light })).toEqual({ resolved: light ? "light" : "dark", preference: "system" });
  });

  it.each([null, "", "AMOLED", "unknown-legacy-theme"])("uses route defaults for an absent or invalid value: %s", (preference) => {
    expect(bootstrap({ preference, pathname: "/" })).toEqual({ resolved: "light", preference: "light" });
    expect(bootstrap({ preference, pathname: "/overview", light: true })).toEqual({ resolved: "dark", preference: "dark" });
  });

  it("retains the route defaults if storage access throws", () => {
    expect(bootstrap({ storageFails: true, pathname: "/" }).resolved).toBe("light");
    expect(bootstrap({ storageFails: true, pathname: "/login" }).resolved).toBe("dark");
  });

  it.each(["missing", "throws"] as const)("falls back to Dark when the system query is %s", (media) => {
    expect(bootstrap({ preference: "system", media })).toEqual({ resolved: "dark", preference: "system" });
    expect(bootstrap({ preference: "amoled", media }).resolved).toBe("amoled");
  });
});
