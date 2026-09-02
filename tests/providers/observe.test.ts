/**
 * The two ends of the observe contract.
 *
 * The sandbox must produce the SAME simulated drift every time it is asked —
 * a demo that reshuffles on every poll is noise, and worse, it would look like
 * infrastructure actually changing. AWS Preview must refuse, because Orrery
 * reads no AWS account and an empty drift list would read as "no drift".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Environment, Manifest } from "@/lib/domain/types";

// The sandbox adapter reaches the store for secret status at deploy time; give
// it a throwaway directory so importing it can never touch a real one.
process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-observe-"));

const { computeDrift } = await import("@/lib/drift");
const { sandboxProvider } = await import("@/lib/providers/sandbox");
const { awsProvider } = await import("@/lib/providers/aws");

const environment: Environment = {
  id: "env-staging",
  projectId: "proj-atlas",
  name: "staging",
  class: "staging",
  connectionId: "conn-sandbox",
  region: "sim-a",
  policies: { approvalRequired: false, allowStatefulDeletion: false },
  baseDomain: "atlas.orrery.test",
  createdAt: "2026-01-01T00:00:00.000Z",
};

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
      env: [{ key: "LOG_LEVEL", value: "info" }],
      ownership: "managed",
    },
    {
      id: "svc-worker",
      name: "worker",
      kind: "worker",
      source: { type: "image", image: "ghcr.io/acme/worker:1" },
      size: "small",
      replicas: 1,
      env: [],
      ownership: "managed",
    },
  ],
  resources: [
    { id: "res-db", name: "main", kind: "postgres", config: {}, size: "small", ownership: "managed" },
    { id: "res-bucket", name: "uploads", kind: "object_store", config: {}, size: "small", ownership: "managed" },
  ],
  routes: [],
  bindings: [],
});

/** Everything but the clock, which is the one thing that must move. */
const withoutTime = (s: { resources: { observedAt: string }[] }) =>
  s.resources.map(({ observedAt: _drop, ...rest }) => rest);

describe("sandbox observe", () => {
  it("says it is simulated", async () => {
    const state = await sandboxProvider.observe!(environment, manifest());
    expect(state.simulated).toBe(true);
  });

  it("returns the same drift every time it is asked", async () => {
    const a = await sandboxProvider.observe!(environment, manifest());
    const b = await sandboxProvider.observe!(environment, manifest());
    expect(withoutTime(b)).toEqual(withoutTime(a));
  });

  it("drifts a different environment differently, and stably", async () => {
    const other = { ...environment, id: "env-prod" };
    const mine = await sandboxProvider.observe!(environment, manifest());
    const theirs = await sandboxProvider.observe!(other, manifest());
    expect(withoutTime(await sandboxProvider.observe!(other, manifest()))).toEqual(
      withoutTime(theirs)
    );
    // Same shape, seeded per environment — both are valid observations.
    expect(theirs.resources.map((r) => r.nodeId).sort()).toEqual(
      mine.resources.map((r) => r.nodeId).sort()
    );
  });

  it("produces exactly the two seeded differences, and nothing missing", async () => {
    const m = manifest();
    const items = computeDrift(m, await sandboxProvider.observe!(environment, m));
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "changed")).toBe(true);
    const fields = items.flatMap((i) => i.fields ?? []).map((f) => f.field);
    expect(fields).toContain("size");
    expect(fields.some((f) => f.startsWith("env:"))).toBe(true);
  });

  it("reports nothing at all for a system with nothing managed in it", async () => {
    const empty: Manifest = { version: 1, services: [], resources: [], routes: [], bindings: [] };
    const state = await sandboxProvider.observe!(environment, empty);
    expect(state.resources).toEqual([]);
    expect(computeDrift(empty, state)).toEqual([]);
  });
});

describe("sandbox discover", () => {
  it("invents a stable set, labelled simulated all the way down", async () => {
    const conn = {
      id: "conn-sandbox",
      workspaceId: "ws",
      provider: "sandbox" as const,
      label: "Sandbox",
      region: "sim-a",
      status: "healthy" as const,
      grantedPermissions: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const first = await sandboxProvider.discover!(conn);
    const again = await sandboxProvider.discover!(conn);
    expect(first.simulated).toBe(true);
    expect(again).toEqual(first);
    expect(first.resources.length).toBeGreaterThan(0);
    // The reference itself has to stay legible as a simulation once it is
    // sitting in a manifest, long after this dialog is closed.
    expect(first.resources.every((r) => r.externalRef.startsWith("sim://"))).toBe(true);
  });
});

describe("aws preview refuses to read", () => {
  it("is preview, not available", () => {
    expect(awsProvider.availability).toBe("preview");
  });

  it("refuses to observe, and names what to do instead", async () => {
    await expect(awsProvider.observe!(environment, manifest())).rejects.toThrow(
      /does not read your AWS account/
    );
    await expect(awsProvider.observe!(environment, manifest())).rejects.toThrow(/terraform plan/);
  });

  it("refuses to discover", async () => {
    await expect(
      awsProvider.discover!({
        id: "conn-aws",
        workspaceId: "ws",
        provider: "aws",
        label: "AWS",
        region: "us-east-1",
        status: "healthy",
        grantedPermissions: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      })
    ).rejects.toThrow(/does not read your AWS account/);
  });
});
