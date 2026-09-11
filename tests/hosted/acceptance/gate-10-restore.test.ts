/**
 * Gate 10 — a clean-directory restore, with revocation reconciliation, and an
 * app that does not reopen itself.
 *
 * The failure this gate exists to prevent is specific: restoring last night's
 * snapshot silently re-admits everybody who was removed today. So the test
 * removes somebody *after* the backup is taken, gets the line off-host through
 * the real outbox handler, restores into an empty directory, **reopens the
 * authority there**, and then asks the gateway — on the app host, with the
 * cookie that person was holding — whether they are in. They are not.
 *
 * The second half is the case where the evidence is missing. With no ledger to
 * reconcile against, the restore cannot prove nobody was removed, so it holds
 * every grant for re-approval and puts the app in `recovering`: the gateway
 * answers 423 and `reopenApp` refuses until an operator says, in as many
 * words, that they have looked at the list.
 *
 * Artifact bytes are deliberately *not* in the bundle (the manifest says so),
 * so this run pins `ZENITH_ARTIFACT_DIR` to one directory both installs read —
 * which is what an operator restoring onto separate object storage would do.
 * That is a modelled arrangement, not a proven one; ACCEPTANCE-R3.md says so.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { HostedApp } from "@/lib/hosted/contracts";
import { IDENTITIES, WORKSPACES, isolatedDataDir, removeDir, uuid } from "../_fixtures";
import {
  OUTSIDER,
  acceptanceEnv,
  appHost,
  appOrigin,
  call,
  closeHosted,
  errorBody,
  loadHosted,
  publishOrThrow,
  releaseOf,
  signIn,
  type HostedModules,
} from "./_journey";

const DATA = isolatedDataDir("zenith-w10-gate10-");
acceptanceEnv(DATA);
/** Artifacts live off the data directory, so a restore elsewhere can still read them. */
const ARTIFACTS = path.join(DATA, "artifact-store");
process.env.ZENITH_ARTIFACT_DIR = ARTIFACTS;

const OFF_HOST = path.join(DATA, "off-host");
const EMPTY_TARGET = path.join(DATA, "no-ledger");
const RESTORE_A = path.join(DATA, "restores", "reconciled");
const RESTORE_B = path.join(DATA, "restores", "no-evidence");

let m: HostedModules;
let app: HostedApp;
let releaseId = "";
let ownerGrantId = "";
let editorGrantId = "";
let viewerGrantId = "";
let editorCookie = "";
let ownerCookie = "";
let bundle: Buffer;
let backupId = "";

const OWNER = IDENTITIES.owner;
const EDITOR = IDENTITIES.editor;
const VIEWER = IDENTITIES.viewer;
const HOST = appHost("alpha");
const ORIGIN = appOrigin("alpha");

/** Point the process at a data directory and open the authority there. */
async function openAt(dir: string): Promise<void> {
  await m.data.closeAllAppData();
  m.authority.closeAuthority();
  process.env.ZENITH_DATA = dir;
  // The gateway caches one artifact store per root; the root has not changed,
  // but the reset also puts every dependency back to the real module.
  m.gateway.resetGatewayDeps();
  m.authority.openAuthority();
}

/** Read a restored control database without writing to it. */
function readControl<T>(dir: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path.join(dir, "control.sqlite"), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  m = await loadHosted();
  m.authority.openAuthority();
  await m.usage.registerOpsOutboxHandlers();

  app = await m.release.createApp({
    workspaceId: WORKSPACES.one.id,
    slug: "alpha",
    name: "Alpha equipment tracker",
    createdBy: OWNER.subject,
    email: OWNER.email,
  });
  const job = await publishOrThrow(m, {
    app,
    actor: OWNER.subject,
    source: { kind: "fixture", name: "minimal-app" },
  });
  releaseId = releaseOf(job).releaseId;

  ownerGrantId = (await m.access.listGrants(app.id))[0].id;
  editorGrantId = (await m.access.grantDirect(
    app.id,
    { subject: EDITOR.subject, email: EDITOR.email, role: "editor" },
    OWNER.subject
  )).id;
  viewerGrantId = (await m.access.grantDirect(
    app.id,
    { subject: VIEWER.subject, email: VIEWER.email, role: "viewer" },
    OWNER.subject
  )).id;

  ownerCookie = await signIn(m, app, OWNER.subject);
  editorCookie = await signIn(m, app, EDITOR.subject);
  await signIn(m, app, VIEWER.subject);

  for (const title of ["Standing desk", "Second monitor", "Docking station"]) {
    const one = call({
      host: HOST,
      path: "/_zenith/data/v1/requests",
      method: "POST",
      cookie: editorCookie,
      origin: ORIGIN,
      accept: "application/json",
      body: JSON.stringify({ writeId: uuid(), record: { title, category: "furniture" } }),
    });
    const res = await m.gateway.handleGateway(one.req, one.params);
    if (res.status !== 201) throw new Error(`seeding ${title} answered ${res.status}`);
  }
}, 300_000);

afterAll(async () => {
  delete process.env.ZENITH_ARTIFACT_DIR;
  await closeHosted(m);
  process.env.ZENITH_DATA = DATA;
  removeDir(DATA);
});

describe("Gate 10 — restore into a clean directory, with reconciliation", () => {
  it("takes a real encrypted backup, and does not put artifact bytes in it", async () => {
    // One revocation before the snapshot, so the ledger exists and the
    // snapshot's high-water mark is not zero.
    const doomed = await m.access.grantDirect(
      app.id,
      { subject: OUTSIDER.subject, email: OUTSIDER.email, role: "viewer" },
      OWNER.subject
    );
    await m.access.revokeGrant(doomed.id, OWNER.subject, "left before the backup", { appId: app.id });
    await m.authority.flushOutbox({ kinds: ["revocation_ledger"] });

    const manifest = await m.backup.createBackup();
    backupId = manifest.id;
    expect(manifest.revocationSeq, "the snapshot records how far the ledger had got").toBe(1);
    expect(manifest.keyId, "sealed under a named key").toMatch(/^[0-9a-f]{8}$/);

    bundle = fs.readFileSync(path.join(OFF_HOST, ...m.backup.backupKeyFor(manifest.id).split("/")));
    expect(bundle.length).toBe(manifest.byteSize);

    const { files } = await m.backup.unpackBundle(
      (await m.backup.unseal(bundle, Buffer.from(process.env.ZENITH_BACKUP_KEY as string, "base64"))).plain
    );
    const inventory = JSON.parse(
      files.find((file) => file.name === "artifacts.json")?.bytes.toString("utf8") as string
    ) as { includesBytes: boolean; note: string };
    expect(inventory.includesBytes, "artifact bytes are inventoried, not carried").toBe(false);
    expect(inventory.note).toMatch(/NOT in this bundle/);
    expect(files.map((file) => file.name)).toContain(`apps/${app.id}/data.sqlite`);
  }, 120_000);

  it("appends a revocation taken after the snapshot to the off-host ledger", async () => {
    await m.access.revokeGrant(editorGrantId, OWNER.subject, "moved teams", { appId: app.id });
    const drained = await m.authority.flushOutbox({ kinds: ["revocation_ledger"] });
    expect(drained.failed, "the ledger append must not fail quietly").toBe(0);
    expect(drained.done).toBeGreaterThan(0);

    const ledger = fs
      .readFileSync(path.join(OFF_HOST, ...m.backup.REVOCATION_LEDGER_KEY.split("/")), "utf8")
      .trim()
      .split("\n");
    expect(ledger.length, "two revocations, one before the snapshot and one after").toBe(2);
    expect(ledger[1], "and the second names the grant that was removed").toContain(editorGrantId);
  });

  it("restores into an empty directory and re-applies the newer revocation", async () => {
    const report = await m.backup.restoreBackup({ bundle, into: RESTORE_A });

    expect(report.reconciliation.evidenceComplete, "the ledger reached past the snapshot").toBe(true);
    expect(report.reconciliation.cutoffSeq).toBe(1);
    expect(report.reconciliation.ledgerMaxSeq).toBe(2);
    expect(report.reconciliation.applied.map((one) => one.grantId), "what it re-applied").toEqual([
      editorGrantId,
    ]);
    expect(report.counts.recordsByApp[0].records, "the records came back").toBe(3);
    expect(report.sessionsTerminated, "every session from the old host is ended").toBeGreaterThan(0);

    // Written into the restored directory, so an operator has the evidence.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(RESTORE_A, m.backup.RESTORE_REPORT_FILE), "utf8")
    ) as { backup: { id: string }; limitations: string[] };
    expect(onDisk.backup.id).toBe(backupId);
    expect(onDisk.limitations.join(" "), "and the report names what it does not establish").toMatch(
      /RPO|artifact/i
    );
    expect(
      readControl(RESTORE_A, (db) =>
        Number(db.prepare("SELECT COUNT(*) AS n FROM hosted_events WHERE event = 'restore.completed'").get()?.n)
      ),
      "the restored install recorded that it was restored"
    ).toBe(1);
  }, 120_000);

  it("keeps the revoked person out of the restored install, through the gateway", async () => {
    await openAt(RESTORE_A);
    const a = m.authority.authority();

    expect((await a.repos.grants.get(editorGrantId))?.state, "the grant removed after the snapshot").toBe(
      "revoked"
    );
    expect((await a.repos.grants.get(ownerGrantId))?.state, "and the ones that were not, were not").toBe(
      "active"
    );
    expect((await a.repos.grants.get(viewerGrantId))?.state).toBe("active");

    // Their old cookie resolves to nothing, and the app host says so.
    const value = editorCookie.split("=")[1];
    expect(await m.access.resolveAppSession(value, app.id), "resolveAppSession on the restored host").toBeNull();
    expect(
      await m.access.resolveAppSessionDetailed(value, app.id),
      "and it says why, without ever answering ok"
    ).toMatchObject({ ok: false });

    await m.gateway.resetGatewayTelemetry();
    const denied = call({ host: HOST, path: "/", cookie: editorCookie, accept: "application/json" });
    const res = await m.gateway.handleGateway(denied.req, denied.params);
    expect(res.status, "the person removed after the snapshot, after the restore").toBe(401);
    expect((await errorBody(res)).code).toBe("sign_in_required");
    expect(m.gateway.gatewayTelemetry.artifactServed).toBe(0);
    expect(m.gateway.gatewayTelemetry.brokerInvoked).toBe(0);

    // And they cannot start a new session either.
    await expect(m.access.createExchange(app.id, EDITOR.subject, `state-${uuid()}`)).rejects.toThrowError(
      /does not have it/
    );
  });

  it("serves the restored app to somebody whose access survived, with their data", async () => {
    // Every session ended with the old host, so this is a fresh launch.
    const cookie = await signIn(m, app, OWNER.subject);
    expect(cookie, "a new session, not the one from before the restore").not.toBe(ownerCookie);

    const page = call({ host: HOST, path: "/", cookie, accept: "text/html" });
    const res = await m.gateway.handleGateway(page.req, page.params);
    expect(res.status, "the restored install serves the release it was serving").toBe(200);
    expect(res.headers.get("x-zenith-release")).toBe(releaseId);

    const read = call({
      host: HOST,
      path: "/_zenith/data/v1/requests?limit=100",
      cookie,
      accept: "application/json",
    });
    const items = ((await (await m.gateway.handleGateway(read.req, read.params)).json()) as {
      items: { title: string }[];
    }).items;
    expect(items.map((item) => item.title).sort(), "the records came back with the app").toEqual([
      "Docking station",
      "Second monitor",
      "Standing desk",
    ]);
  });

  /* ------------------------- the evidence-missing case ------------------- */

  it("holds every grant and refuses to serve when there is no ledger to reconcile against", async () => {
    const report = await m.backup.restoreBackup({
      bundle,
      into: RESTORE_B,
      target: new m.backup.FilesystemTarget(EMPTY_TARGET),
    });

    expect(report.reconciliation.ledgerAvailable, "no ledger at the target").toBe(false);
    expect(report.reconciliation.evidenceComplete).toBe(false);
    expect(report.reconciliation.detail).toMatch(/Evidence missing/);
    expect(report.reconciliation.needsReapproval, "every grant is held").toBeGreaterThan(0);
    expect(report.reconciliation.appsRecovering).toBe(1);
    expect(report.counts.grantsByState.active, "nobody is live in this restore").toBe(0);
    expect(
      report.counts.recordsByApp[0].records,
      "and nothing was thrown away to achieve that"
    ).toBe(3);

    await openAt(RESTORE_B);
    const a = m.authority.authority();
    expect((await a.repos.apps.get(app.id))?.state).toBe("recovering");
    expect((await a.repos.apps.get(app.id))?.stateReason).toMatch(/could not be confirmed against the off-host ledger/);
    expect((await a.repos.grants.get(ownerGrantId))?.state, "even the owner is held").toBe("needs_reapproval");

    await m.gateway.resetGatewayTelemetry();
    const held = call({ host: HOST, path: "/", accept: "application/json" });
    const res = await m.gateway.handleGateway(held.req, held.params);
    expect(res.status, "an app in recovery does not serve").toBe(423);
    const body = await errorBody(res);
    expect(body.code).toBe("recovering");
    expect(body.fix, "and the refusal says what an owner has to do").toMatch(/re-approve/);
    expect(m.gateway.gatewayTelemetry.artifactServed).toBe(0);

    // A held grant cannot even start a launch.
    await expect(m.access.createExchange(app.id, OWNER.subject, `state-${uuid()}`)).rejects.toThrowError();
  }, 120_000);

  it("refuses to reopen the app until an operator says they have seen the held list", async () => {
    const store = new m.artifacts.FsArtifactStore(ARTIFACTS);
    await expect(
      m.backup.reopenApp(app.id, { operator: "w10-acceptance", artifacts: store })
    ).rejects.toMatchObject({ code: "recovering" });

    // The refusal names the people, so the operator can act on it.
    try {
      await m.backup.reopenApp(app.id, { operator: "w10-acceptance", artifacts: store });
      throw new Error("reopenApp was expected to refuse");
    } catch (err) {
      const details = (err as { details?: { heldGrants?: { email: string }[] } }).details;
      expect(details?.heldGrants?.map((one) => one.email).sort()).toContain(OWNER.email);
    }
    expect((await m.authority.authority().repos.apps.get(app.id))?.state, "and it stays closed").toBe(
      "recovering"
    );
  });

  it("reopens on an explicit acknowledgement, and still does not re-approve anybody", async () => {
    const store = new m.artifacts.FsArtifactStore(ARTIFACTS);
    const result = await m.backup.reopenApp(app.id, {
      operator: "w10-acceptance",
      acknowledgeReapproval: true,
      artifacts: store,
    });
    expect(result.app.state, "the app is open again").toBe("active");
    expect(result.checks.every((check) => check.ok), JSON.stringify(result.checks)).toBe(true);
    expect(result.grantsNeedingReapproval, "and the held list is unchanged").toBeGreaterThan(0);

    const a = m.authority.authority();
    expect((await a.repos.grants.get(ownerGrantId))?.state, "reopening is not re-approving").toBe(
      "needs_reapproval"
    );

    // So the app answers again — and turns everybody away for lack of a grant,
    // which is a different refusal from the one before.
    const anyone = call({ host: HOST, path: "/", accept: "application/json" });
    const res = await m.gateway.handleGateway(anyone.req, anyone.params);
    expect(res.status).toBe(401);
    expect((await errorBody(res)).code).toBe("sign_in_required");
    await expect(m.access.createExchange(app.id, OWNER.subject, `state-${uuid()}`)).rejects.toThrowError(
      /does not have it/
    );
  });
});
