import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/engine/engine", () => ({ ensureEngine: vi.fn() }));
vi.mock("@/lib/providers/types", () => ({ providerRegistry: () => new Map() }));
vi.mock("@/app/_landing/landing", () => ({ Landing: () => null }));

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

describe("landing metadata build configuration", () => {
  it.each([undefined, "", "   "])("builds with an unset or blank site URL (%j)", async (value) => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", value);
    const page = await import("@/app/page");
    expect(page.metadata.metadataBase?.href).toBe("http://localhost:3400/");
    expect(page.dynamic).toBe("force-static");
  });

  it("preserves a configured absolute URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", " https://zenith.example/ ");
    const { metadata } = await import("@/app/page");
    expect(metadata.metadataBase?.href).toBe("https://zenith.example/");
  });

  it("does not silently replace an invalid nonblank configuration", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "not-a-url");
    await expect(import("@/app/page")).rejects.toThrow(/Invalid URL/);
  });
});
