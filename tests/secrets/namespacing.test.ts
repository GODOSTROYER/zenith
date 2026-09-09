/**
 * Whose value is it, anyway.
 *
 * A reference used to be `vault:<KEY>`, so two unrelated services that both
 * read DATABASE_URL shared one row in the store: rotating one re-credentialled
 * the other, and removing one deleted the value the other still needed. A
 * generated reference now carries the project and the service that asked for
 * it — `vault:<projectId>/<serviceId>/<KEY>` — and no stored value is deleted
 * while anything else still references it.
 *
 * This file is that promise, end to end:
 *   - same key name, two services, two values;
 *   - rotating one leaves the other alone;
 *   - removing one never destroys a value something else still reads —
 *     whether the other reader is another service, another project's service,
 *     or a revision that is still deployed;
 *   - deliberate sharing still works, because an explicit secretRef wins;
 *   - a legacy bare `vault:KEY` still resolves, still rotates, and is never
 *     silently swapped for a namespaced reference (which would orphan it);
 *   - and through all of it, no value reaches the manifest, the state file,
 *     the audit log or an export bundle.
 *
 * `tests/secrets/store.test.ts` is the store itself and the happy path; this
 * file is what happens when two things want the same name.
 */
import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionContext } from "@/lib/actions/core";
import type { Manifest, Revision } from "@/lib/domain/types";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-ns-"));
process.env.ORRERY_DATA = DATA;
process.env.ORRERY_SECRET_KEY = crypto.randomBytes(32).toString("base64");

const { runAction } = await import("@/lib/actions/core");
const { db, flush, q, readAudit, resetDb } = await import("@/lib/db/store");
const { listSecrets, putSecret, readSecretValue, secretStatus } = await import("@/lib/secrets");
const { sandboxProvider } = await import("@/lib/providers/sandbox");
await import("@/lib/actions/defs");

const WS = "ws-ns";
const ctx: ActionContext = {
  workspaceId: WS,
  actor: { type: "user", id: "u-alice", name: "Alice" },
};

/** Every value this file stores. The last test proves none of them travel. */
const VALUES = {
  apiDb: "pg://ns-api-one",
  apiDbRotated: "pg://ns-api-two",
  workerDb: "pg://ns-worker-one",
  shared: "pg://ns-shared-one",
  otherProject: "pg://ns-other-project",
  legacy: "pg://ns-legacy-one",
  legacyReplaced: "pg://ns-legacy-two",
  relay: "pg://ns-relay-live",
};

let projectId = "";
let otherProjectId = "";
const pctx = () => ({ ...ctx, projectId });
const manifest = () => q.project(projectId)!.workingManifest;
const svc = (name: string) => manifest().services.find((s) => s.name === name)!;
/** The reference actually recorded on a variable — what the manifest holds. */
const envRef = (service: string, key: string) =>
  svc(service).env.find((e) => e.key === key)?.secretRef;
/** The reference `system.setSecret` generates for a service and a key. */
const generated = (service: string, key: string) =>
  `vault:${projectId}/${svc(service).id}/${key}`;

const exec = (actionId: string, input: unknown, scope: Partial<ActionContext> = {}) =>
  runAction(actionId, { ...pctx(), ...scope }, input, { mode: "execute" }).then((r) => r.result!);
const plan = (actionId: string, input: unknown, scope: Partial<ActionContext> = {}) =>
  runAction(actionId, { ...pctx(), ...scope }, input, { mode: "plan" }).then((r) => r.plan!);

const ok = async (actionId: string, input: unknown, scope: Partial<ActionContext> = {}) => {
  const result = await exec(actionId, input, scope);
  if (!result.ok) throw new Error(`${actionId} failed: ${result.error ?? result.summary}`);
  return result;
};

beforeAll(async () => {
  resetDb({
    workspaces: [{ id: WS, name: "Namespacing", slug: "ns", createdAt: new Date().toISOString() }],
  });
  const created = await runAction("project.create", ctx, { name: "Atlas" }, { mode: "execute" });
  projectId = (created.result!.data as { projectId: string }).projectId;
  const other = await runAction("project.create", ctx, { name: "Beacon" }, { mode: "execute" });
  otherProjectId = (other.result!.data as { projectId: string }).projectId;

  for (const name of ["api", "worker", "gateway", "legacy-svc", "relay"])
    await ok("system.addService", { name, kind: "worker", image: `ghcr.io/acme/${name}:1` });
  await ok("system.addService", { name: "reader", kind: "worker", image: "ghcr.io/acme/reader:1" }, {
    projectId: otherProjectId,
  });
});

/* --------------------------- one name, two secrets -------------------------- */

describe("two services with the same variable name do not share a value", () => {
  it("gives each service its own reference, and each reference its own value", async () => {
    await ok("system.setSecret", {
      serviceId: "api",
      key: "DATABASE_URL",
      secretValue: VALUES.apiDb,
    });
    await ok("system.setSecret", {
      serviceId: "worker",
      key: "DATABASE_URL",
      secretValue: VALUES.workerDb,
    });

    const apiRef = envRef("api", "DATABASE_URL")!;
    const workerRef = envRef("worker", "DATABASE_URL")!;

    // The key alone is not the identity: the project and the service are in it.
    expect(apiRef).toBe(generated("api", "DATABASE_URL"));
    expect(workerRef).toBe(generated("worker", "DATABASE_URL"));
    expect(apiRef).not.toBe(workerRef);
    expect(apiRef).toContain(projectId);
    expect(apiRef).toContain(svc("api").id);

    // Two rows in the store, two different values. This is the finding.
    expect(readSecretValue(WS, apiRef)).toBe(VALUES.apiDb);
    expect(readSecretValue(WS, workerRef)).toBe(VALUES.workerDb);
    expect(listSecrets(WS).filter((s) => s.ref.endsWith("/DATABASE_URL"))).toHaveLength(2);
  });

  it("says in the plan that the generated reference is scoped, and how to share instead", async () => {
    const preview = await plan("system.setSecret", {
      serviceId: "gateway",
      key: "DATABASE_URL",
      secretValue: "pg://never-applied",
    });
    const text = preview.details.join(" ");
    expect(text).toContain(generated("gateway", "DATABASE_URL"));
    expect(text).toMatch(/scoped to this service/i);
    expect(text).toMatch(/pass that service's secretRef explicitly/i);
    expect(JSON.stringify(preview)).not.toContain("pg://never-applied");
  });

  it("keeps the reference when the service is renamed — it is built from ids", async () => {
    const before = envRef("worker", "DATABASE_URL")!;
    await ok("system.updateService", { serviceId: svc("worker").id, name: "worker-renamed" });
    expect(envRef("worker-renamed", "DATABASE_URL")).toBe(before);
    expect(readSecretValue(WS, before)).toBe(VALUES.workerDb);
    await ok("system.updateService", { serviceId: svc("worker-renamed").id, name: "worker" });
  });
});

/* --------------------------------- rotation -------------------------------- */

describe("rotating one service's secret leaves the other's alone", () => {
  it("writes only the reference it was pointed at", async () => {
    const apiRef = envRef("api", "DATABASE_URL")!;
    const workerRef = envRef("worker", "DATABASE_URL")!;

    await ok("system.rotateSecret", {
      serviceId: "api",
      key: "DATABASE_URL",
      secretValue: VALUES.apiDbRotated,
    });

    expect(readSecretValue(WS, apiRef)).toBe(VALUES.apiDbRotated);
    expect(secretStatus(WS, apiRef)).toMatchObject({ version: 2 });
    // The whole point: the other service was not re-credentialled.
    expect(readSecretValue(WS, workerRef)).toBe(VALUES.workerDb);
    expect(secretStatus(WS, workerRef)).toMatchObject({ version: 1 });
  });

  it("names the one variable that reads it, so a rotation's blast radius is visible", async () => {
    const preview = await plan("system.rotateSecret", {
      serviceId: "api",
      key: "DATABASE_URL",
      secretValue: "pg://never-applied",
    });
    expect(preview.details.join(" ")).toContain("Atlas/api.DATABASE_URL");
    expect(preview.warnings.join(" ")).not.toMatch(/is shared/i);
  });
});

/* ------------------------- deliberate sharing, and removal ------------------ */

describe("sharing one value is explicit, and removal never destroys it", () => {
  it("points a second service at an existing reference when asked, and says they share", async () => {
    const workerRef = envRef("worker", "DATABASE_URL")!;

    const preview = await plan("system.setSecret", {
      serviceId: "gateway",
      key: "DATABASE_URL",
      secretRef: workerRef,
    });
    expect(preview.details.join(" ")).toMatch(/reads the same value/i);

    await ok("system.setSecret", { serviceId: "gateway", key: "DATABASE_URL", secretRef: workerRef });
    expect(envRef("gateway", "DATABASE_URL")).toBe(workerRef);
    expect(envRef("worker", "DATABASE_URL")).toBe(workerRef);
  });

  it("warns that a rotation of a shared reference re-credentials everything on it", async () => {
    const preview = await plan("system.rotateSecret", {
      serviceId: "worker",
      key: "DATABASE_URL",
      secretValue: "pg://never-applied",
    });
    expect(preview.warnings.join(" ")).toMatch(/is shared/i);
    expect(preview.warnings.join(" ")).toContain("Atlas/gateway.DATABASE_URL");
  });

  it("keeps the stored value when another service still references it", async () => {
    const workerRef = envRef("worker", "DATABASE_URL")!;
    await ok("system.rotateSecret", {
      serviceId: "worker",
      key: "DATABASE_URL",
      secretValue: VALUES.shared,
    });

    const preview = await plan("system.removeSecret", { serviceId: "gateway", key: "DATABASE_URL" });
    expect(preview.details.join(" ")).toMatch(/STAYS in Zenith's secret store/);
    expect(preview.details.join(" ")).toContain("Atlas/worker.DATABASE_URL");

    const result = await ok("system.removeSecret", { serviceId: "gateway", key: "DATABASE_URL" });
    expect(result.data).toMatchObject({ valueKept: true });

    // The reference is gone from the manifest; the value another service still
    // reads is not gone from the store.
    expect(envRef("gateway", "DATABASE_URL")).toBeUndefined();
    expect(readSecretValue(WS, workerRef)).toBe(VALUES.shared);
    expect(secretStatus(WS, workerRef).exists).toBe(true);
  });

  it("protects a value another PROJECT in the workspace still reads", async () => {
    const workerRef = envRef("worker", "DATABASE_URL")!;
    await ok(
      "system.setSecret",
      { serviceId: "reader", key: "DATABASE_URL", secretRef: workerRef },
      { projectId: otherProjectId }
    );

    const preview = await plan("system.removeSecret", { serviceId: "worker", key: "DATABASE_URL" });
    expect(preview.details.join(" ")).toContain("Beacon/reader.DATABASE_URL");

    const result = await ok("system.removeSecret", { serviceId: "worker", key: "DATABASE_URL" });
    expect(result.data).toMatchObject({ valueKept: true });
    expect(readSecretValue(WS, workerRef)).toBe(VALUES.shared);
  });

  it("deletes the value with the LAST reference, and only then", async () => {
    const workerRef = q
      .project(otherProjectId)!
      .workingManifest.services.find((s) => s.name === "reader")!
      .env.find((e) => e.key === "DATABASE_URL")!.secretRef!;

    const preview = await plan(
      "system.removeSecret",
      { serviceId: "reader", key: "DATABASE_URL" },
      { projectId: otherProjectId }
    );
    expect(preview.details.join(" ")).toMatch(/Nothing else in this workspace references/);

    const result = await ok(
      "system.removeSecret",
      { serviceId: "reader", key: "DATABASE_URL" },
      { projectId: otherProjectId }
    );
    expect(result.data).toMatchObject({ valueKept: false });
    expect(secretStatus(WS, workerRef).exists).toBe(false);
    expect(readSecretValue(WS, workerRef)).toBeUndefined();

    // api's own DATABASE_URL was never involved in any of that.
    expect(readSecretValue(WS, envRef("api", "DATABASE_URL")!)).toBe(VALUES.apiDbRotated);
  });
});

/* --------------------------------- legacy ---------------------------------- */

describe("a bare vault:KEY from before namespacing keeps working", () => {
  const LEGACY = "vault:LEGACY_URL";

  it("resolves, and is not swapped for a namespaced reference behind your back", async () => {
    // Exactly what an import (or any older Zenith) left behind: a bare
    // reference on the variable, and a value stored under it.
    q.project(projectId)!
      .workingManifest.services.find((s) => s.name === "legacy-svc")!
      .env.push({ key: "LEGACY_URL", secretRef: LEGACY });
    putSecret(WS, LEGACY, VALUES.legacy, "Alice");
    expect(readSecretValue(WS, LEGACY)).toBe(VALUES.legacy);

    // Storing a new value through the action writes where the variable already
    // points. Re-pointing it at a namespaced reference would leave the stored
    // value behind with nothing naming it — an orphan nobody can reach.
    const preview = await plan("system.setSecret", {
      serviceId: "legacy-svc",
      key: "LEGACY_URL",
      secretValue: "pg://never-applied",
    });
    expect(preview.details.join(" ")).toMatch(/already reads from vault:LEGACY_URL/);

    await ok("system.setSecret", {
      serviceId: "legacy-svc",
      key: "LEGACY_URL",
      secretValue: VALUES.legacyReplaced,
    });
    expect(envRef("legacy-svc", "LEGACY_URL")).toBe(LEGACY);
    expect(readSecretValue(WS, LEGACY)).toBe(VALUES.legacyReplaced);
    expect(secretStatus(WS, LEGACY)).toMatchObject({ version: 2 });
  });

  it("rotates in place, and is protected on removal like any other reference", async () => {
    await ok("system.setSecret", { serviceId: "api", key: "LEGACY_URL", secretRef: LEGACY });

    await ok("system.rotateSecret", {
      serviceId: "legacy-svc",
      key: "LEGACY_URL",
      secretValue: VALUES.legacy,
    });
    expect(readSecretValue(WS, LEGACY)).toBe(VALUES.legacy);

    // Two services on one legacy reference is the shape the finding described.
    // Removing one no longer takes the value out from under the other.
    const result = await ok("system.removeSecret", { serviceId: "legacy-svc", key: "LEGACY_URL" });
    expect(result.data).toMatchObject({ valueKept: true });
    expect(readSecretValue(WS, LEGACY)).toBe(VALUES.legacy);
    expect(envRef("api", "LEGACY_URL")).toBe(LEGACY);
  });
});

/* ---------------------- a revision that is still deployed ------------------- */

describe("a value a live revision still reads is kept, not deleted", () => {
  it("counts the deployed manifest as a consumer and says which environment", async () => {
    await ok("system.setSecret", {
      serviceId: "relay",
      key: "RELAY_TOKEN",
      secretValue: VALUES.relay,
    });
    const relayRef = envRef("relay", "RELAY_TOKEN")!;

    // A revision deployed to staging that still reads the reference. Written
    // directly because what matters here is the state a deploy leaves behind,
    // not the deploy machinery — `tests/actions/deploy.test.ts` owns that.
    const deployed: Manifest = structuredClone(manifest());
    deployed.services = deployed.services
      .filter((s) => s.name === "relay")
      .map((s) => ({ ...s, env: [{ key: "RELAY_TOKEN", secretRef: relayRef }] }));
    deployed.bindings = [];
    deployed.routes = [];

    const revision: Revision = {
      id: "rev-live-ns",
      projectId,
      number: 1,
      manifest: deployed,
      message: "deployed to staging",
      author: ctx.actor,
      createdAt: new Date().toISOString(),
    };
    db().revisions.push(revision);
    db().environments.push({
      id: "env-live-ns",
      projectId,
      name: "staging",
      class: "staging",
      connectionId: "conn-sandbox",
      region: "local-1",
      deployedRevisionId: revision.id,
      policies: { approvalRequired: false, allowStatefulDeletion: false },
      baseDomain: "atlas.orrery.test",
      createdAt: new Date().toISOString(),
    });
    flush(); // moves the revision's manifest to its side file, as a deploy would

    const preview = await plan("system.removeSecret", { serviceId: "relay", key: "RELAY_TOKEN" });
    expect(preview.details.join(" ")).toMatch(/STAYS in Zenith's secret store/);
    expect(preview.details.join(" ")).toContain("live in staging");
    expect(preview.warnings.join(" ")).toMatch(/rollback or a redeploy/i);

    const result = await ok("system.removeSecret", { serviceId: "relay", key: "RELAY_TOKEN" });
    expect(result.data).toMatchObject({ valueKept: true });
    expect(envRef("relay", "RELAY_TOKEN")).toBeUndefined();
    // The rollback target can still be redeployed with its credential.
    expect(readSecretValue(WS, relayRef)).toBe(VALUES.relay);
  });
});

/* ----------------------- and still: values do not travel -------------------- */

describe("namespaced or legacy, the value stays in the store", () => {
  it("is absent from the manifest, the state file, the audit log and an export", async () => {
    flush();

    const values = Object.values(VALUES);
    const manifestJson = JSON.stringify([
      manifest(),
      q.project(otherProjectId)!.workingManifest,
      q.revisionManifest("rev-live-ns"),
    ]);
    const state = fs.readFileSync(path.join(DATA, "state.json"), "utf8");
    const audit = fs.readFileSync(path.join(DATA, "audit.jsonl"), "utf8");
    const auditRows = JSON.stringify(readAudit({ projectId }));

    const bundle = sandboxProvider.exportBundle!(
      {
        id: "env-live-ns",
        projectId,
        name: "staging",
        class: "staging",
        connectionId: "conn-sandbox",
        region: "local-1",
        policies: { approvalRequired: false, allowStatefulDeletion: false },
        baseDomain: "atlas.orrery.test",
        createdAt: new Date().toISOString(),
      },
      manifest()
    );
    const exported = JSON.stringify(bundle);

    for (const value of values) {
      expect(manifestJson).not.toContain(value);
      expect(state).not.toContain(value);
      expect(audit).not.toContain(value);
      expect(auditRows).not.toContain(value);
      expect(exported).not.toContain(value);
    }

    // The reference travels — including the project and service in it, which
    // are ids, not credentials.
    expect(exported).toContain(generated("api", "DATABASE_URL"));
    // And the store still holds what the manifest points at.
    expect(readSecretValue(WS, envRef("api", "DATABASE_URL")!)).toBe(VALUES.apiDbRotated);
  });
});
