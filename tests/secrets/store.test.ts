/**
 * The secret store, and the promise it makes: Zenith.ai holds the value, and
 * nothing that leaves the server holds the value.
 *
 * The refusal side — what happens with no `ORRERY_SECRET_KEY` — is in
 * `tests/actions/system.test.ts`, which runs with the variable unset. Two
 * files because the store reads its key from the process environment, and a
 * test that mutates that mid-run tests the mutation, not the store.
 */
import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionContext } from "@/lib/actions/core";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-secrets-"));
process.env.ORRERY_DATA = DATA;
process.env.ORRERY_SECRET_KEY = crypto.randomBytes(32).toString("base64");

const { runAction } = await import("@/lib/actions/core");
const { flush, q, readAudit, resetDb } = await import("@/lib/db/store");
const {
  listSecrets,
  putSecret,
  readSecretValue,
  removeSecret,
  secretStatus,
  secretStoreState,
} = await import("@/lib/secrets");
const { sandboxProvider } = await import("@/lib/providers/sandbox");
const { syncFindings } = await import("@/lib/security/rules");
await import("@/lib/actions/defs");

const WS = "ws-secrets";
const ctx: ActionContext = {
  workspaceId: WS,
  actor: { type: "user", id: "u-alice", name: "Alice" },
};

let projectId = "";
const pctx = () => ({ ...ctx, projectId });
const manifest = () => q.project(projectId)!.workingManifest;
const api = () => manifest().services.find((s) => s.name === "api")!;

/**
 * The reference `system.setSecret` generates for a variable on `api`. It names
 * the project and the service, not just the key, so two services that both read
 * DATABASE_URL do not land on one stored value — tests/secrets/namespacing.test.ts
 * is that promise on its own. Written as a helper here so these tests keep
 * asserting what they were written to assert: where the value goes, and that it
 * never travels with it.
 */
const ref = (key: string) => `vault:${projectId}/${api().id}/${key}`;

const exec = (actionId: string, input: unknown) =>
  runAction(actionId, pctx(), input, { mode: "execute" }).then((r) => r.result!);
const plan = (actionId: string, input: unknown) =>
  runAction(actionId, pctx(), input, { mode: "plan" }).then((r) => r.plan!);

const ok = async (actionId: string, input: unknown) => {
  const result = await exec(actionId, input);
  if (!result.ok) throw new Error(`${actionId} failed: ${result.error ?? result.summary}`);
  return result;
};

beforeAll(async () => {
  resetDb({
    workspaces: [{ id: WS, name: "Secrets", slug: "secrets", createdAt: new Date().toISOString() }],
  });
  const created = await runAction("project.create", ctx, { name: "Atlas" }, { mode: "execute" });
  projectId = (created.result!.data as { projectId: string }).projectId;
  await ok("system.addService", { name: "api", kind: "web", image: "ghcr.io/acme/api:1", port: 8080 });
});

/* --------------------------------- crypto ---------------------------------- */

describe("values are encrypted at rest and readable only on this server", () => {
  it("round-trips a value, and never writes it in the clear", () => {
    expect(secretStoreState().configured).toBe(true);
    const meta = putSecret(WS, "vault:ROUND_TRIP", "sk_live_round_trip", "Alice");
    expect(meta.version).toBe(1);
    expect(readSecretValue(WS, "vault:ROUND_TRIP")).toBe("sk_live_round_trip");

    const onDisk = fs.readFileSync(path.join(DATA, "secrets.json"), "utf8");
    expect(onDisk).not.toContain("sk_live_round_trip");
    expect(onDisk).toContain("vault:ROUND_TRIP"); // the reference is not the secret
  });

  it("returns metadata and existence, never the value", () => {
    const status = secretStatus(WS, "vault:ROUND_TRIP");
    expect(status.exists).toBe(true);
    expect(JSON.stringify(status)).not.toContain("sk_live_round_trip");
    expect(secretStatus(WS, "vault:NOT_THERE")).toEqual({ ref: "vault:NOT_THERE", exists: false });
  });

  it("refuses a row that was moved to another workspace or reference", () => {
    // The workspace and ref are authenticated with the value, so a lifted row
    // fails to open instead of silently decrypting as somebody else's secret.
    const file = path.join(DATA, "secrets.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.workspaces["ws-other"] = { "vault:ROUND_TRIP": data.workspaces[WS]["vault:ROUND_TRIP"] };
    fs.writeFileSync(file, JSON.stringify(data), "utf8");
    expect(() => readSecretValue("ws-other", "vault:ROUND_TRIP")).toThrow(/cannot be opened/i);
  });

  it("refuses an oversized value rather than turning the store into a filesystem", () => {
    expect(() => putSecret(WS, "vault:HUGE", "x".repeat(9000), "Alice")).toThrow(/at most/i);
  });
});

/* ------------------------------ setSecret ---------------------------------- */

describe("system.setSecret stores the value and records only the reference", () => {
  it("writes a reference to the manifest and the value to the store", async () => {
    const result = await ok("system.setSecret", {
      serviceId: "api",
      key: "STRIPE_KEY",
      secretValue: "sk_live_stripe_value",
    });
    expect(result.data).toMatchObject({ secretRef: ref("STRIPE_KEY") });

    const entry = api().env.find((e) => e.key === "STRIPE_KEY")!;
    expect(entry.secretRef).toBe(ref("STRIPE_KEY"));
    expect(entry.value).toBeUndefined();
    expect(readSecretValue(WS, ref("STRIPE_KEY"))).toBe("sk_live_stripe_value");
  });

  it("keeps the value out of the manifest, the state file, the audit log and the export", async () => {
    const VALUE = "sk_live_stripe_value";
    flush();

    expect(JSON.stringify(manifest())).not.toContain(VALUE);
    expect(fs.readFileSync(path.join(DATA, "state.json"), "utf8")).not.toContain(VALUE);

    const row = readAudit({ projectId }).find((r) => r.actionId === "system.setSecret")!;
    expect((row.input as { key: string }).key).toBe("STRIPE_KEY"); // a name is not a secret
    expect(JSON.stringify(row.input)).not.toContain(VALUE);
    expect(fs.readFileSync(path.join(DATA, "audit.jsonl"), "utf8")).not.toContain(VALUE);

    const bundle = sandboxProvider.exportBundle!(
      {
        id: "env-x",
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
    expect(exported).not.toContain(VALUE);
    expect(exported).toContain(ref("STRIPE_KEY")); // the reference travels, the value does not
  });

  it("says what is stored where before it does it", async () => {
    const preview = await plan("system.setSecret", {
      serviceId: "api",
      key: "PLANNED_KEY",
      secretValue: "sk_live_planned",
    });
    expect(preview.blocked).toBeUndefined();
    const text = preview.details.join(" ");
    expect(text).toMatch(/AES-256-GCM/);
    expect(text).toContain(`secret store as ${ref("PLANNED_KEY")}`);
    expect(text).toMatch(/manifest records only/i);
    expect(JSON.stringify(preview)).not.toContain("sk_live_planned");
  });

  it("refuses to write a value into somebody else's secret manager", async () => {
    const result = await exec("system.setSecret", {
      serviceId: "api",
      key: "ELSEWHERE",
      secretRef: "aws:ssm/atlas/elsewhere",
      secretValue: "sk_live_not_ours",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not Zenith.ai's store/i);
    expect(api().env.some((e) => e.key === "ELSEWHERE")).toBe(false);
  });

  it("still records a bare reference, and says nothing is behind it yet", async () => {
    const preview = await plan("system.setSecret", { serviceId: "api", key: "LATER_KEY" });
    expect(preview.details.join(" ")).toContain(`Nothing is stored at ${ref("LATER_KEY")} yet`);
    await ok("system.setSecret", { serviceId: "api", key: "LATER_KEY" });
    expect(api().env.find((e) => e.key === "LATER_KEY")!.secretRef).toBe(ref("LATER_KEY"));
    expect(secretStatus(WS, ref("LATER_KEY")).exists).toBe(false);
  });
});

/* -------------------------------- rotation --------------------------------- */

describe("system.rotateSecret sets a new value under the same reference", () => {
  it("bumps the version, replaces the value, and leaves the manifest alone", async () => {
    const before = JSON.stringify(manifest());
    const preview = await plan("system.rotateSecret", {
      serviceId: "api",
      key: "STRIPE_KEY",
      secretValue: "sk_live_rotated",
    });
    expect(preview.details.join(" ")).toMatch(/v1 to v2/);
    expect(preview.warnings.join(" ")).toMatch(/next deploy/i);

    const result = await ok("system.rotateSecret", {
      serviceId: "api",
      key: "STRIPE_KEY",
      secretValue: "sk_live_rotated",
    });
    expect(result.data).toMatchObject({ version: 2 });
    expect(readSecretValue(WS, ref("STRIPE_KEY"))).toBe("sk_live_rotated");
    expect(secretStatus(WS, ref("STRIPE_KEY"))).toMatchObject({ version: 2, updatedBy: "Alice" });
    expect(JSON.stringify(manifest())).toBe(before); // a rotation is not a manifest edit

    const row = readAudit({ projectId }).find((r) => r.actionId === "system.rotateSecret")!;
    expect(JSON.stringify(row.input)).not.toContain("sk_live_rotated");
  });

  it("keeps createdAt/createdBy and moves updatedAt", () => {
    const status = secretStatus(WS, ref("STRIPE_KEY"));
    if (!status.exists) throw new Error("expected a stored secret");
    expect(status.createdBy).toBe("Alice");
    expect(status.updatedAt >= status.createdAt).toBe(true);
  });

  it("refuses a reference with nothing behind it, and one Zenith.ai does not own", async () => {
    const empty = await exec("system.rotateSecret", {
      secretRef: "vault:NEVER_SET",
      secretValue: "x",
    });
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/Nothing is stored/i);

    const theirs = await exec("system.rotateSecret", {
      secretRef: "aws:ssm/atlas/db",
      secretValue: "x",
    });
    expect(theirs.ok).toBe(false);
    expect(theirs.error).toMatch(/your own secret manager/i);
  });
});

/* --------------------------------- removal --------------------------------- */

describe("system.removeSecret removes the reference and the value together", () => {
  it("takes both, and warns that running services keep their copy", async () => {
    await ok("system.setSecret", { serviceId: "api", key: "DOOMED_KEY", secretValue: "sk_live_doomed" });
    expect(secretStatus(WS, ref("DOOMED_KEY")).exists).toBe(true);

    const preview = await plan("system.removeSecret", { serviceId: "api", key: "DOOMED_KEY" });
    expect(preview.details.join(" ")).toMatch(/deleted from Zenith.ai's secret store/i);
    expect(preview.warnings.join(" ")).toMatch(/until it is redeployed/i);

    await ok("system.removeSecret", { serviceId: "api", key: "DOOMED_KEY" });
    expect(api().env.some((e) => e.key === "DOOMED_KEY")).toBe(false);
    expect(secretStatus(WS, ref("DOOMED_KEY")).exists).toBe(false);
    expect(readSecretValue(WS, ref("DOOMED_KEY"))).toBeUndefined();
    expect(listSecrets(WS).map((s) => s.ref)).not.toContain(ref("DOOMED_KEY"));
  });

  it("refuses on a plain variable, and names the action that does remove it", async () => {
    await ok("system.setEnvVar", { serviceId: "api", key: "LOG_LEVEL", value: "info" });
    const result = await exec("system.removeSecret", { serviceId: "api", key: "LOG_LEVEL" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/system\.setEnvVar/);
    expect(api().env.find((e) => e.key === "LOG_LEVEL")!.value).toBe("info");
  });

  it("warns when setEnvVar drops a reference and leaves the value behind", async () => {
    await ok("system.setSecret", { serviceId: "api", key: "ORPHAN_KEY", secretValue: "sk_live_orphan" });
    const preview = await plan("system.setEnvVar", { serviceId: "api", key: "ORPHAN_KEY", value: null });
    expect(preview.warnings.join(" ")).toMatch(/system\.removeSecret/);
    await ok("system.removeSecret", { serviceId: "api", key: "ORPHAN_KEY" });
  });
});

/* ------------------------- the security fix, for real ---------------------- */

describe("the plaintext-secret finding's fix moves the value without losing it", () => {
  it("stores the plaintext, swaps in the reference, and closes the finding", async () => {
    const PLAINTEXT = "pk_live_sitting_in_the_manifest";
    // setEnvVar refuses secret-looking keys, so plant it the way an import would.
    const project = q.project(projectId)!;
    project.workingManifest.services
      .find((s) => s.name === "api")!
      .env.push({ key: "SESSION_SECRET", value: PLAINTEXT });

    const finding = syncFindings(projectId).find((f) => f.id.startsWith("sf_plaintext_secret"));
    expect(finding?.fix).toMatchObject({
      actionId: "system.setSecret",
      input: { key: "SESSION_SECRET", moveExistingValue: true },
      label: "Move to the secret store",
    });

    const fix = finding!.fix!;
    const result = await ok(fix.actionId, { ...(fix.input as Record<string, unknown>), projectId });
    expect(result.summary).toMatch(/secret store/i);

    const entry = api().env.find((e) => e.key === "SESSION_SECRET")!;
    expect(entry.secretRef).toBe(ref("SESSION_SECRET"));
    expect(entry.value).toBeUndefined();
    // The value moved — it was not destroyed, and it is not in the manifest.
    expect(readSecretValue(WS, ref("SESSION_SECRET"))).toBe(PLAINTEXT);
    expect(JSON.stringify(manifest())).not.toContain(PLAINTEXT);

    expect(syncFindings(projectId).some((f) => f.id.startsWith("sf_plaintext_secret"))).toBe(false);
  });

  it("refuses when there is no plaintext to move, and changes nothing", async () => {
    const result = await exec("system.setSecret", {
      serviceId: "api",
      key: "SESSION_SECRET",
      moveExistingValue: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no plaintext value to move/i);
    expect(api().env.find((e) => e.key === "SESSION_SECRET")!.secretRef).toBe(ref("SESSION_SECRET"));
  });
});

/* ---------------------------------- listing -------------------------------- */

describe("listing is metadata, scoped to one workspace", () => {
  it("returns every reference with a value, and no values", () => {
    const rows = listSecrets(WS);
    expect(rows.map((r) => r.ref)).toEqual(
      expect.arrayContaining([ref("STRIPE_KEY"), ref("SESSION_SECRET")])
    );
    expect(JSON.stringify(rows)).not.toContain("sk_live");
    expect(rows.every((r) => r.version >= 1 && r.createdBy && r.updatedAt)).toBe(true);
    expect(listSecrets("ws-nobody")).toEqual([]);
  });

  it("removes cleanly", () => {
    expect(removeSecret(WS, "vault:ROUND_TRIP")).toMatchObject({ ref: "vault:ROUND_TRIP" });
    expect(removeSecret(WS, "vault:ROUND_TRIP")).toBeUndefined();
  });
});
