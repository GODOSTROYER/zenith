/**
 * Drift computation — the three kinds, and the two silences.
 *
 * The silences are the load-bearing part. A node the provider did not report
 * on must produce nothing (not "fine"), and a secret-backed env var must never
 * be compared at all, because Zenith does not hold the value it would compare
 * against. Both are cases where the tempting behaviour is to reassure.
 */
import { describe, expect, it } from "vitest";
import type { Manifest } from "@/lib/domain/types";
import type { LiveState } from "@/lib/providers/types";
import { computeDrift, expectedAttributes } from "@/lib/drift";

const manifest = (): Manifest => ({
  version: 1,
  services: [
    {
      id: "svc-api",
      name: "api",
      kind: "web",
      source: { type: "image", image: "ghcr.io/acme/api:1" },
      size: "small",
      replicas: 2,
      port: 3000,
      env: [
        { key: "LOG_LEVEL", value: "info" },
        { key: "DB_PASSWORD", secretRef: "vault:DB_PASSWORD" },
      ],
      ownership: "managed",
    },
  ],
  resources: [
    { id: "res-db", name: "main", kind: "postgres", config: {}, size: "small", ownership: "managed" },
    { id: "res-cache", name: "cache", kind: "redis", config: {}, size: "small", ownership: "managed" },
    {
      id: "res-legacy",
      name: "legacy",
      kind: "object_store",
      config: {},
      size: "small",
      ownership: "referenced",
      externalRef: "s3://legacy",
    },
  ],
  routes: [],
  bindings: [],
});

const at = "2026-09-02T10:00:00.000Z";

const live = (resources: LiveState["resources"]): LiveState => ({
  simulated: false,
  observedAt: at,
  resources,
});

describe("expectedAttributes", () => {
  it("describes a service by size, replicas and its plain env vars", () => {
    const attrs = expectedAttributes(manifest().services[0]);
    expect(attrs).toEqual({ size: "small", replicas: 2, "env:LOG_LEVEL": "info" });
  });

  it("never exposes a secret-backed variable — there is no value to compare", () => {
    expect(expectedAttributes(manifest().services[0])).not.toHaveProperty("env:DB_PASSWORD");
  });
});

describe("computeDrift", () => {
  it("reports a resource the provider cannot find as missing, and stateful loss as high", () => {
    const items = computeDrift(
      manifest(),
      live([{ nodeId: "res-db", kind: "postgres", exists: false, attributes: {}, observedAt: at }])
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("missing");
    expect(items[0].severity).toBe("high");
    expect(items[0].nodeName).toBe("main");
    expect(items[0].detail).toMatch(/data is gone/);
  });

  it("reports differing attributes as changed, with both values", () => {
    const items = computeDrift(
      manifest(),
      live([
        {
          nodeId: "svc-api",
          kind: "web",
          exists: true,
          attributes: { size: "small", replicas: 5, "env:LOG_LEVEL": "debug" },
          observedAt: at,
        },
      ])
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("changed");
    expect(items[0].fields).toEqual([
      { field: "env:LOG_LEVEL", expected: "info", observed: "debug" },
      { field: "replicas", expected: "2", observed: "5" },
    ]);
  });

  it("reports something nothing in the revision owns as extra", () => {
    const items = computeDrift(
      manifest(),
      live([
        {
          nodeId: "",
          kind: "queue",
          exists: true,
          attributes: { externalRef: "sqs://orphan", name: "orphan" },
          observedAt: at,
        },
      ])
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("extra");
    expect(items[0].severity).toBe("low");
    expect(items[0].nodeName).toBe("orphan");
    expect(items[0].externalRef).toBe("sqs://orphan");
    expect(items[0].detail).toMatch(/will not touch it/);
  });

  it("says nothing about a node the provider did not report on", () => {
    // res-cache is absent from the observation entirely. Silence is "not
    // looked at" — claiming it matches would be the lie this rule prevents.
    expect(computeDrift(manifest(), live([]))).toEqual([]);
  });

  it("ignores keys the manifest does not expect, and referenced nodes entirely", () => {
    const items = computeDrift(
      manifest(),
      live([
        {
          nodeId: "svc-api",
          kind: "web",
          exists: true,
          // A value for the secret, and a field Zenith has no opinion about.
          attributes: { "env:DB_PASSWORD": "hunter2", uptimeSeconds: 900 },
          observedAt: at,
        },
        {
          nodeId: "res-legacy",
          kind: "object_store",
          exists: false,
          attributes: {},
          observedAt: at,
        },
      ])
    );
    expect(items).toEqual([]);
  });

  it("orders the worst first", () => {
    const items = computeDrift(
      manifest(),
      live([
        { nodeId: "", kind: "queue", exists: true, attributes: { name: "orphan" }, observedAt: at },
        {
          nodeId: "svc-api",
          kind: "web",
          exists: true,
          attributes: { replicas: 9 },
          observedAt: at,
        },
        { nodeId: "res-db", kind: "postgres", exists: false, attributes: {}, observedAt: at },
      ])
    );
    expect(items.map((i) => i.severity)).toEqual(["high", "medium", "low"]);
  });
});
