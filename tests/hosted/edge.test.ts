/**
 * The edge host split: which Host headers are app hosts, where they are
 * rewritten, and that a control-origin request is left alone.
 */
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isolatedDataDir } from "./_fixtures";

isolatedDataDir("zenith-edge-");

const { hostedRewrite, isPlatformStaticPath, edgeAppDomain } = await import("@/lib/hosted/edge");
const { slugFromHost, gatewayPath, isValidAppSlug, GATEWAY_PREFIX } = await import(
  "@/lib/hosted/contracts"
);

afterEach(() => {
  delete process.env.ZENITH_APP_DOMAIN;
});

describe("slugFromHost", () => {
  it("names the slug under the app domain, ignoring port and case", () => {
    expect(slugFromHost("Alpha.apps.localhost:3400", "apps.localhost")).toBe("alpha");
    expect(slugFromHost("beta-2.apps.example.com", "apps.example.com")).toBe("beta-2");
  });

  it("refuses everything that is not exactly one valid label under the domain", () => {
    for (const host of [
      "localhost:3400",
      "apps.localhost",
      "a.b.apps.localhost",
      "-bad.apps.localhost",
      "x.apps.localhost", // too short
      "alpha.apps.localhost.evil.com",
      "alphaapps.localhost",
      "",
      null,
      undefined,
    ])
      expect(slugFromHost(host, "apps.localhost"), String(host)).toBeNull();
  });

  it("rejects reserved and malformed slugs for app creation", () => {
    for (const s of ["www", "api", "zenith", "ab", "-abc", "abc-", "Abc", "a".repeat(41)])
      expect(isValidAppSlug(s), s).toBe(false);
    expect(isValidAppSlug("alpha")).toBe(true);
    expect(isValidAppSlug("team-tracker-2")).toBe(true);
  });
});

describe("gatewayPath", () => {
  it("routes under the gateway prefix with the host encoded once", () => {
    expect(gatewayPath("alpha.apps.localhost:3400", "/")).toBe(`${GATEWAY_PREFIX}/alpha.apps.localhost%3A3400`);
    expect(gatewayPath("alpha.apps.localhost", "/_zenith/data/v1/requests")).toBe(
      `${GATEWAY_PREFIX}/alpha.apps.localhost/_zenith/data/v1/requests`
    );
  });
});

describe("hostedRewrite", () => {
  it("rewrites an app-host request onto the gateway and marks it no-store", () => {
    const req = new NextRequest("http://alpha.apps.localhost:3400/assets/app.js?v=1", {
      headers: { host: "alpha.apps.localhost:3400", cookie: "sb-access-token=secret" },
    });
    const res = hostedRewrite(req);
    expect(res).not.toBeNull();
    const target = res!.headers.get("x-middleware-rewrite");
    expect(target).toContain(`${GATEWAY_PREFIX}/alpha.apps.localhost%3A3400/assets/app.js`);
    expect(target).toContain("v=1");
    expect(res!.headers.get("cache-control")).toBe("no-store");
  });

  it("leaves the control origin alone", () => {
    const req = new NextRequest("http://localhost:3400/overview", { headers: { host: "localhost:3400" } });
    expect(hostedRewrite(req)).toBeNull();
  });

  it("honours ZENITH_APP_DOMAIN", () => {
    process.env.ZENITH_APP_DOMAIN = "apps.example.com";
    expect(edgeAppDomain()).toBe("apps.example.com");
    const req = new NextRequest("https://alpha.apps.example.com/", { headers: { host: "alpha.apps.example.com" } });
    expect(hostedRewrite(req)).not.toBeNull();
    const local = new NextRequest("http://alpha.apps.localhost/", { headers: { host: "alpha.apps.localhost" } });
    expect(hostedRewrite(local)).toBeNull();
  });
});

describe("isPlatformStaticPath", () => {
  it("matches exactly what the old matcher excluded", () => {
    for (const p of ["/favicon.ico", "/fonts/x.woff2", "/logo.svg", "/a/b.png"]) expect(isPlatformStaticPath(p), p).toBe(true);
    for (const p of ["/p/design-png", "/fonts/nested/x.woff2", "/p/private.woff2", "/overview", "/api/me"])
      expect(isPlatformStaticPath(p), p).toBe(false);
  });
});
