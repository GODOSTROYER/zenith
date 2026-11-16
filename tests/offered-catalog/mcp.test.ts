/**
 * `zenith_get_capabilities` exposes the versioned offered capability catalog
 * summary (PROD-LIFE-02) with the same self-contained MCP harness the other
 * v3 read tests use.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOfferedCatalog } from "@/lib/offered-catalog";
import { argsFor, makeHarness } from "../agent-v3/support";

afterEach(() => vi.restoreAllMocks());

describe("zenith_get_capabilities offered catalog", () => {
  it("returns the catalog version, digest, level policy and per-provider domain rollups", async () => {
    const h = await makeHarness();
    const result = await h.invoke("zenith_get_capabilities", argsFor("zenith_get_capabilities"));
    expect(result.ok).toBe(true);
    const catalog = getOfferedCatalog();
    const offered = result.data.offeredCatalog as { catalogVersion: string; contentDigest: string; providers: { provider: string; domains: unknown[] }[]; levelPolicy: Record<string, string> };
    expect(offered.catalogVersion).toBe(catalog.catalogVersion);
    expect(offered.contentDigest).toBe(catalog.contentDigest);
    expect(Object.keys(offered.levelPolicy).sort()).toEqual(["preview", "supported", "unsupported"]);
    expect(offered.providers.map((p) => p.provider)).toEqual(catalog.providers);
    for (const p of offered.providers) expect(p.domains).toHaveLength(16);
  });

  it("does not return per-cell detail (that is the REST surface) and stays small", async () => {
    const h = await makeHarness();
    const result = await h.invoke("zenith_get_capabilities", argsFor("zenith_get_capabilities"));
    const text = JSON.stringify(result.data.offeredCatalog);
    expect(text).not.toContain("lifecycle");
    expect(text.length).toBeLessThan(64 * 1024);
  });
});
