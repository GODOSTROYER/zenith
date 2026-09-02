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

/** Next compiles each matcher string to a path regex; this is that regex. */
const gated = (pathname: string): boolean =>
  config.matcher.some((m) => new RegExp(`^${m}$`).test(pathname));

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

  it("gates ordinary product and API paths", () => {
    for (const p of ["/overview", "/p/atlas/navigator", "/api/bootstrap"])
      expect(gated(p), p).toBe(true);
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
