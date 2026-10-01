/**
 * The additive `release.migrate` section of Manifest V2.
 */
import { describe, expect, it } from "vitest";
import { MigrateHook, parseManifest, Release } from "@/lib/resources/manifest-v2";
import { downgradeToV1 } from "@/lib/resources/upgrade";
import { expandManifest, manifestDigest } from "@/lib/resources";
import type { ManifestV2 } from "@/lib/resources/manifest-v2";
import { webDbManifest } from "./fakes/fixtures";

const base = (release: unknown, extra: Record<string, unknown> = {}): unknown => {
  const m = webDbManifest();
  return { version: 2, services: m.services, resources: m.resources, routes: m.routes, bindings: m.bindings, placement: { provider: "aws", regions: ["us-east-1"] }, ...extra, release };
};

const parse = (release: unknown, extra?: Record<string, unknown>) => parseManifest(base(release, extra));
const errors = (release: unknown, extra?: Record<string, unknown>): string[] => {
  const r = parse(release, extra);
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
};

describe("release.migrate", () => {
  it("accepts a service name, an argv vector and an optional timeout", () => {
    const r = parse({ migrate: { service: "web", command: ["node", "migrate.js", "--up"], timeoutSec: 300 } });
    expect(r.ok).toBe(true);
    expect((r.manifest as ManifestV2).release).toEqual({ migrate: { service: "web", command: ["node", "migrate.js", "--up"], timeoutSec: 300 } });
  });

  it("is optional: a manifest without a release section parses exactly as before", () => {
    const m = webDbManifest();
    const r = parseManifest({ version: 2, services: m.services, resources: m.resources, routes: m.routes, bindings: m.bindings });
    expect(r.ok).toBe(true);
    expect((r.manifest as ManifestV2).release).toBeUndefined();
    expect(parse({}).ok).toBe(true); // an empty release section declares nothing
  });

  it("is strict: an unknown key anywhere in the section is rejected, not dropped", () => {
    expect(errors({ migrate: { service: "web", command: ["x"] }, rollback: { service: "web", command: ["y"] } }).join("\n")).toMatch(/rollback|Unrecognized/i);
    expect(errors({ migrate: { service: "web", command: ["x"], shell: true } }).join("\n")).toMatch(/shell|Unrecognized/i);
    expect(Release.safeParse({ migrate: { service: "web", command: ["x"] }, extra: 1 }).success).toBe(false);
  });

  it("needs a non-empty argv of at most 32 elements", () => {
    expect(errors({ migrate: { service: "web", command: [] } }).join("\n")).toMatch(/command/);
    expect(errors({ migrate: { service: "web" } }).join("\n")).toMatch(/command/);
    expect(parse({ migrate: { service: "web", command: Array.from({ length: 32 }, (_, i) => `a${i}`) } }).ok).toBe(true);
    expect(errors({ migrate: { service: "web", command: Array.from({ length: 33 }, (_, i) => `a${i}`) } }).join("\n")).toMatch(/command/);
  });

  it("is an argv vector, not a shell string: a string where the array belongs is refused", () => {
    expect(errors({ migrate: { service: "web", command: "node migrate.js && rm -rf /" } }).join("\n")).toMatch(/command/);
  });

  it("refuses empty, oversized and control-character elements", () => {
    expect(errors({ migrate: { service: "web", command: ["node", ""] } }).join("\n")).toMatch(/cannot be empty/);
    expect(errors({ migrate: { service: "web", command: ["x".repeat(1025)] } }).join("\n")).toMatch(/command/);
    expect(errors({ migrate: { service: "web", command: ["node\nmigrate"] } }).join("\n")).toMatch(/control characters/);
    expect(errors({ migrate: { service: "web", command: ["a\u0000b"] } }).join("\n")).toMatch(/control characters/);
    expect(parse({ migrate: { service: "web", command: ["sh", "-c", "npm run migrate"] } }).ok).toBe(true); // legal: it is still one argv element each
  });

  it("refuses a URL with embedded credentials on the command line", () => {
    expect(errors({ migrate: { service: "web", command: ["migrate", "--db", "postgres://admin:hunter2@db:5432/app"] } }).join("\n")).toMatch(/embeds credentials in a URL/);
    expect(parse({ migrate: { service: "web", command: ["migrate", "--db", "postgres://db:5432/app"] } }).ok).toBe(true);
  });

  it("bounds the timeout to 1..3600 whole seconds", () => {
    for (const bad of [0, -1, 3601, 1.5, "60"]) expect(parse({ migrate: { service: "web", command: ["x"], timeoutSec: bad } }).ok, String(bad)).toBe(false);
    for (const good of [1, 60, 3600]) expect(parse({ migrate: { service: "web", command: ["x"], timeoutSec: good } }).ok, String(good)).toBe(true);
  });

  it("must name a service of this manifest by NAME, and not a static site or a service Zenith does not run", () => {
    expect(errors({ migrate: { service: "ghost", command: ["x"] } }).join("\n")).toMatch(/release.migrate.service: "ghost" is not a service/);
    expect(errors({ migrate: { service: "Web", command: ["x"] } }).join("\n")).toMatch(/service/); // not a valid name at all
    expect(errors({ migrate: { service: "svc-web", command: ["x"] } }).join("\n")).toMatch(/service/); // an id is not a name

    const m = webDbManifest();
    const site = { id: "svc-site", name: "site", kind: "static", source: { type: "image", image: "x" }, size: "small", replicas: 1, env: [], ownership: "managed" };
    expect(errors({ migrate: { service: "site", command: ["x"] } }, { services: [...m.services, site] }).join("\n")).toMatch(/static site/);
    const foreign = { ...m.services[0], id: "svc-ext", name: "ext", ownership: "external" };
    expect(errors({ migrate: { service: "ext", command: ["x"] } }, { services: [...m.services, foreign] }).join("\n")).toMatch(/external; Zenith does not run it/);
  });

  it("exports its schemas, and they match what the manifest accepts", () => {
    expect(MigrateHook.safeParse({ service: "web", command: ["x"] }).success).toBe(true);
    expect(MigrateHook.safeParse({ service: "web", command: [] }).success).toBe(false);
  });

  it("changes the manifest digest but not the resource graph", () => {
    const env = { id: "env-1", name: "production", class: "production" as const, provider: "aws" as const, region: "us-east-1", baseDomain: "atlas.zenith.test" };
    const without = parse(undefined).manifest as ManifestV2;
    const withRelease = parse({ migrate: { service: "web", command: ["node", "migrate.js"] } }).manifest as ManifestV2;
    expect(manifestDigest(withRelease)).not.toBe(manifestDigest(without));
    const a = expandManifest(without, env);
    const b = expandManifest(withRelease, env);
    expect(b.graphDigest).toBe(a.graphDigest);
    expect(b.nodes).toEqual(a.nodes);
  });

  it("is a V2-only section: downgrading to V1 drops it, like placement and policies", () => {
    const m = parse({ migrate: { service: "web", command: ["x"] } }).manifest as ManifestV2;
    expect("release" in downgradeToV1(m)).toBe(false);
  });
});
