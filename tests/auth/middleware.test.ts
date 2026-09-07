/**
 * The auth gate's two path decisions, which had no test at all.
 *
 * The matcher is the gate: a path it does not match never reaches
 * `updateSession`, so an escaping bug there is a silent auth bypass rather
 * than an error anyone would see.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-mw-"));

const { config } = await import("@/middleware");
const { isPublicPath } = await import("@/lib/supabase/env");
const { isPlatformStaticPath } = await import("@/lib/hosted/edge");

/**
 * The gate is two stages since hosted R3: Next compiles each matcher string
 * to a path regex (stage one, so app-host asset requests reach the
 * middleware at all), and `isPlatformStaticPath` skips the session check for
 * the platform's own static files (stage two, what the matcher exclusion used
 * to do). A path is gated when it passes both.
 */
const matched = (pathname: string): boolean =>
  config.matcher.some((m) => new RegExp(`^${m}$`).test(pathname));
const gated = (pathname: string): boolean => matched(pathname) && !isPlatformStaticPath(pathname);

describe("middleware matcher", () => {
  it("gates a page whose slug merely ends in an image extension", () => {
    // With a single backslash the dot matched any character, so every one of
    // these bypassed auth entirely.
    for (const p of ["/p/design-png", "/p/logo_svg", "/api/projects/faviconXico", "/p/a-webp"])
      expect(gated(p), p).toBe(true);
  });

  it("still skips real static assets and image optimization", () => {
    for (const p of ["/_next/static/chunks/x.png", "/_next/image", "/favicon.ico", "/logo.svg"])
      expect(gated(p), p).toBe(false);
  });

  it("lets image paths reach the middleware so an app host can gate them", () => {
    // Stage one must match; stage two is what skips them on the control host.
    for (const p of ["/favicon.ico", "/logo.svg", "/assets/app-3f2a.png"]) expect(matched(p), p).toBe(true);
    expect(matched("/_next/static/chunks/x.png")).toBe(false);
  });

  it("gates ordinary product and API paths", () => {
    for (const p of ["/overview", "/p/atlas/navigator", "/api/bootstrap"])
      expect(gated(p), p).toBe(true);
  });

  it("serves the bundled fonts before sign-in without exempting app paths", () => {
    expect(gated("/fonts/36966cca54120369-s.p.woff2")).toBe(false);
    for (const p of ["/p/private.woff2", "/api/fonts/private.woff2", "/fonts/private", "/fonts/nested/private.woff2"]) {
      expect(gated(p), p).toBe(true);
    }
  });
});

describe("public paths", () => {
  it("keeps the sandbox activation page public", () => {
    expect(isPublicPath("/preview/dep-1/svc-1")).toBe(true);
  });

  it("does not hand the whole /preview prefix out unauthenticated", () => {
    for (const p of ["/preview", "/preview/dep-1", "/preview/dep-1/svc-1/secrets"])
      expect(isPublicPath(p), p).toBe(false);
  });

  it("keeps the auth screens and the landing page public, and nothing else", () => {
    for (const p of ["/", "/login", "/signup", "/auth/callback", "/reset-password"])
      expect(isPublicPath(p), p).toBe(true);
    for (const p of ["/overview", "/api/bootstrap", "/p/atlas"])
      expect(isPublicPath(p), p).toBe(false);
  });
});
