/**
 * Reopening a restored app: the deliberate second step.
 *
 * This suite runs the whole path on one machine — build a real app with a real
 * artifact, back it up, restore it into an empty directory, point the process
 * at the restored directory, and try to reopen. Reopening has to refuse twice
 * for two different reasons before it succeeds once: grants that a human has
 * to look at, and checks that no human may wave through.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-backup-reopen-");
const restoredDir = path.join(path.dirname(dataDir), `${path.basename(dataDir)}-restored`);
process.env.ZENITH_BACKUP_KEY = Buffer.alloc(32, 11).toString("base64");
process.env.ZENITH_BACKUP_TARGET = "filesystem";
process.env.ZENITH_BACKUP_DIR = path.join(dataDir, "off-host");

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { createBackup, reopenApp, restoreBackup } = await import("@/lib/hosted/backup");
const { closeAllAppData } = await import("@/lib/hosted/data");
const { HostedError } = await import("@/lib/hosted/contracts");
const { EDITOR, OWNER, seedActiveRelease, seedApp, seedArtifact, seedGrant, seedRecord } = await import(
  "./_ops-fixtures"
);

let a = openAuthority();
const app = seedApp(a, { slug: "reopen-app", workspaceId: "ws-reopen" });
seedGrant(a, app.id, OWNER, "owner");
seedGrant(a, app.id, EDITOR, "editor");

afterAll(() => {
  closeAllAppData();
  closeAuthority();
  removeDir(dataDir);
  removeDir(restoredDir);
});

/** The thrown value as a HostedError, so a failure names what actually came out. */
async function refusal(promise: Promise<unknown>): Promise<InstanceType<typeof HostedError>> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HostedError) return error;
    throw error;
  }
  throw new Error("expected the reopen to be refused, and it was not");
}

const artifactFile = (digest: string): string =>
  path.join(restoredDir, "artifacts", "sha256", digest, "files", "index.html");

let digest = "";

describe("reopenApp after a restore", () => {
  it("restores an app with its artifact and leaves it recovering", async () => {
    const artifact = await seedArtifact(a, path.join(dataDir, "artifacts"), { marker: "reopen" });
    digest = artifact.digest;
    seedActiveRelease(a, app.id, digest);
    for (let n = 0; n < 4; n++) await seedRecord(app.id, { title: `Record ${n}` });

    // Artifact bytes included: this drill is about a host that lost everything.
    const manifest = await createBackup({ includeArtifacts: true });

    closeAllAppData();
    closeAuthority();

    const bundle = fs.readFileSync(
      path.join(dataDir, "off-host", "backups", `${manifest.id}.zbk`)
    );
    // No ledger was ever written (nothing was revoked), so the restore cannot
    // prove nobody was removed and closes every grant — the state this whole
    // file is about.
    const report = await restoreBackup({ bundle, into: restoredDir });
    expect(report.reconciliation.evidenceComplete).toBe(false);
    expect(report.counts.grantsByState.needs_reapproval).toBe(2);
    expect(report.counts.artifacts).toMatchObject({ referenced: 1, present: 1, missing: [] });
    expect(fs.existsSync(artifactFile(digest))).toBe(true);

    // From here on, this process *is* the restored install.
    process.env.ZENITH_DATA = restoredDir;
    a = openAuthority();
    expect(a.repos.apps.get(app.id)?.state).toBe("recovering");
  }, 60_000);

  it("refuses while grants are held, and says reopening does not re-approve anybody", async () => {
    const error = await refusal(reopenApp(app.id, { operator: "ops@zenith.test" }));
    expect(error.code).toBe("recovering");
    expect(error.message).toMatch(/2 grant\(s\) held for re-approval/);
    expect(error.fix).toMatch(/does not re-approve anybody/);
    expect((error.details?.heldGrants as unknown[]).length).toBe(2);
    expect(a.repos.apps.get(app.id)?.state).toBe("recovering");
  });

  it("reopens once an operator acknowledges the held grants and every check passes", async () => {
    const result = await reopenApp(app.id, { operator: "ops@zenith.test", acknowledgeReapproval: true });

    expect(result.app.state).toBe("active");
    expect(result.app.stateReason).toBeUndefined();
    expect(result.grantsNeedingReapproval).toBe(2);
    expect(result.detail).toMatch(/2 grant\(s\) remain held/);
    expect(result.checks.map((check) => check.id).sort()).toEqual([
      "active_release",
      "artifact_verified",
      "control.quick_check",
      "data.quick_check",
      "schema_version",
    ]);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    // The restored data really is there.
    expect(result.checks.find((check) => check.id === "artifact_verified")?.detail).toMatch(/matches/);
    expect(a.repos.events.listSince({ event: "app.resumed" }, { limit: 5 })).toHaveLength(1);
    // Held grants stay held: reopening is not re-approval.
    expect(a.repos.grants.listByApp(app.id).every((grant) => grant.state === "needs_reapproval")).toBe(true);
  });

  it("refuses on a failed check, and no acknowledgement overrides it", async () => {
    a.tx(() => a.repos.apps.update(app.id, { state: "recovering", stateReason: "drill" }));
    const original = fs.readFileSync(artifactFile(digest));
    // One byte, same length: the size check cannot catch this, so it is the
    // content hash that has to.
    const tampered = Buffer.from(original);
    tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x3e ? 0x3d : 0x3e;
    fs.writeFileSync(artifactFile(digest), tampered);
    try {
      const error = await refusal(
        reopenApp(app.id, { operator: "ops@zenith.test", acknowledgeReapproval: true })
      );
      expect(error.code).toBe("recovering");
      expect(error.message).toMatch(/did not pass its post-restore checks/);
      const checks = error.details?.checks as { id: string; ok: boolean; detail: string }[];
      expect(checks.find((check) => check.id === "artifact_verified")?.ok).toBe(false);
      expect(checks.find((check) => check.id === "artifact_verified")?.detail).toMatch(/has changed/);
      // Everything else still passed: the report names what is wrong, not "something".
      expect(checks.filter((check) => !check.ok)).toHaveLength(1);
      expect(a.repos.apps.get(app.id)?.state).toBe("recovering");
    } finally {
      fs.writeFileSync(artifactFile(digest), original);
    }
  });

  it("refuses an app that has no active release, because there is nothing to serve", async () => {
    const orphan = seedApp(a, { slug: "no-release-app", workspaceId: "ws-reopen" });
    const error = await refusal(reopenApp(orphan.id, { operator: "ops@zenith.test" }));
    const checks = error.details?.checks as { id: string; ok: boolean; detail: string }[];
    expect(checks.find((check) => check.id === "active_release")?.detail).toMatch(/nothing for it to serve/);
  });

  it("refuses an app id that does not exist", async () => {
    const error = await refusal(
      reopenApp("00000000-0000-4000-8000-000000000000", { operator: "ops@zenith.test" })
    );
    expect(error.code).toBe("not_found");
  });
});
