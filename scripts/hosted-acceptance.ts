/**
 * The hosted journey, end to end, in one process.
 *
 * Run:
 *   npx tsx scripts/hosted-acceptance.ts
 *
 * `scripts/smoke.ts` does this for the infrastructure product; this is its
 * counterpart for hosted apps, and it is the step CI runs after the suite so a
 * regression in the *sequence* — not in any one module — is caught. Everything
 * is real: a `recipe-local` build of `fixtures/tracker-app`, a content-
 * addressed artifact, a loopback HTTP server in front of `handleGateway`, a
 * hashed single-use invitation, an exchange redeemed over a socket, the fixed
 * broker writing to a per-app SQLite file, an encrypted backup, and a restore
 * into an empty directory that has to reconcile a revocation it did not know
 * about when the snapshot was taken.
 *
 *   publish → invite → accept → launch → write → conflict → backup → revoke →
 *   denied → restore → assert
 *
 * The backup is deliberately taken **before** the revocation. A snapshot taken
 * afterwards would already contain it, and the restore would prove nothing
 * about reconciliation — which is the property that stops a restore from
 * silently re-admitting somebody who was removed.
 *
 * Exit 0 when every check passed, 1 otherwise. Nothing is skipped.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/* Environment first: `@/lib/env` reads ORRERY_DATA on first use, so every
   application module below is imported dynamically, after this block. */
const DATA_DIR = path.join(process.cwd(), ".data-hosted-acceptance");
const ARTIFACT_DIR = path.join(DATA_DIR, "artifact-store");
const OFF_HOST = path.join(DATA_DIR, "off-host");
const RESTORE_INTO = path.join(DATA_DIR, "restore");

process.env.ORRERY_DATA = DATA_DIR;
process.env.ORRERY_FAST = "1";
process.env.ZENITH_BUILD_RUNNER = "recipe-local";
process.env.ZENITH_RUNTIME = "local";
process.env.ZENITH_APP_DOMAIN = "apps.localhost";
process.env.ZENITH_APP_SCHEME = "http";
process.env.ZENITH_ARTIFACT_DIR = ARTIFACT_DIR;
process.env.ZENITH_BACKUP_TARGET = "filesystem";
process.env.ZENITH_BACKUP_DIR = OFF_HOST;
process.env.ZENITH_BACKUP_KEY = Buffer.alloc(32, 13).toString("base64");
process.env.ORRERY_SECRET_KEY = "1".repeat(64);
delete process.env.ORRERY_SMTP_URL;

const OWNER = { subject: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
const RECIPIENT = { subject: "55555555-5555-4555-8555-555555555555", email: "rae.recipient@example.test" };
const SLUG = "alpha";

/** One line of the table this script prints. */
interface Row {
  step: string;
  ok: boolean;
  detail: string;
}

const rows: Row[] = [];

/** Record a check. Returns what it was given, so it reads inline. */
function check(step: string, ok: boolean, detail: string): boolean {
  rows.push({ step, ok, detail });
  return ok;
}

/** Record a check that must hold for the run to continue. */
function must(step: string, ok: boolean, detail: string): void {
  check(step, ok, detail);
  if (!ok) throw new Error(`${step}: ${detail}`);
}

function table(): string {
  const width = Math.max(...rows.map((row) => row.step.length), 4);
  const lines = rows.map(
    (row) => `${row.ok ? " ok  " : "FAIL "} ${row.step.padEnd(width)}  ${row.detail}`
  );
  return lines.join("\n");
}

async function main(): Promise<number> {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const journey = await import("../tests/hosted/acceptance/_journey");
  const access = await import("@/lib/hosted/access");
  const artifacts = await import("@/lib/hosted/artifacts");
  const authority = await import("@/lib/hosted/authority");
  const backup = await import("@/lib/hosted/backup");
  const data = await import("@/lib/hosted/data");
  const gateway = await import("@/lib/hosted/gateway");
  const health = await import("@/lib/hosted/health");
  const release = await import("@/lib/hosted/release");
  const usage = await import("@/lib/hosted/usage");

  const a = authority.openAuthority();
  usage.registerOpsOutboxHandlers();
  access.registerAccessOutboxHandlers();
  check(
    "environment",
    true,
    `node ${process.version}, sqlite ${String(a.db.prepare("SELECT sqlite_version() AS v").get()?.v)}, data ${DATA_DIR}`
  );

  const server = await journey.startGatewayServer(gateway.handleGateway);
  process.env.ZENITH_CONTROL_ORIGIN = `http://localhost:${server.port}`;
  const host = `${SLUG}.apps.localhost:${server.port}`;
  const origin = `http://${host}`;
  const store = new artifacts.FsArtifactStore(ARTIFACT_DIR);

  let recipientCookie = "";
  let ownerCookie = "";
  let recordId = "";
  let grantId = "";
  let releaseId = "";
  let appId = "";

  try {
    /* ------------------------------- publish ------------------------------ */

    const app = await release.createApp({
      workspaceId: "ws-acceptance",
      slug: SLUG,
      name: "Alpha equipment tracker",
      createdBy: OWNER.subject,
      email: OWNER.email,
    });
    appId = app.id;

    const jobId = randomUUID();
    await release.admitPublish({
      jobId,
      appId: app.id,
      workspaceId: app.workspaceId,
      actor: OWNER.subject,
      source: { kind: "fixture", name: "tracker-app" },
    });
    const job = await release.runJobOnce(jobId);
    must(
      "publish",
      job.status === "succeeded",
      job.status === "succeeded"
        ? `release ${String(job.phaseData.releaseNumber)} from a real recipe-local build`
        : `${job.status} in ${job.phase}: ${job.error ?? "no error recorded"}`
    );
    releaseId = String(job.phaseData.releaseId);
    const digest = String(job.phaseData.artifactDigest);

    const verdict = await store.verify(digest);
    must("artifact verified", verdict.ok, `${digest.slice(0, 12)} — ${verdict.detail}`);

    /* -------------------------------- invite ------------------------------ */

    const issued = access.createInvite(app.id, { email: RECIPIENT.email, role: "editor" }, OWNER.subject);
    const token = new URL(issued.acceptUrl).searchParams.get("token") as string;
    check(
      "invite",
      issued.invite.state === "pending" && !JSON.stringify(issued.invite).includes(token),
      `hashed, single use, expires ${issued.invite.expiresAt}`
    );

    /* -------------------------------- accept ------------------------------ */

    const accepted = access.acceptInvite(token, {
      subject: RECIPIENT.subject,
      email: RECIPIENT.email,
      emailVerified: true,
      sessionId: "provider-session",
    });
    grantId = accepted.grant.id;
    must(
      "accept",
      accepted.grant.role === "editor" && accepted.grant.state === "active",
      `${RECIPIENT.email} holds ${accepted.grant.role} on ${app.slug}, with no workspace membership`
    );

    let replayed = false;
    try {
      access.acceptInvite(token, {
        subject: RECIPIENT.subject,
        email: RECIPIENT.email,
        emailVerified: true,
      });
    } catch {
      replayed = true;
    }
    check("invite is single use", replayed, "a second acceptance of the same link is refused");

    /* -------------------------------- launch ------------------------------ */

    recipientCookie = await redeem(journey, access, server.port, host, app.id, RECIPIENT.subject);
    must("launch", recipientCookie.length > 0, `__Host-zenith_app minted on ${host}`);
    ownerCookie = await redeem(journey, access, server.port, host, app.id, OWNER.subject);

    const session = await journey.loopbackRequest(server.port, {
      host,
      path: "/_zenith/session",
      headers: { cookie: recipientCookie, accept: "application/json" },
    });
    const info = JSON.parse(session.body) as { subject: string; role: string; releaseId: string };
    check(
      "session",
      info.subject === RECIPIENT.subject && info.role === "editor" && info.releaseId === releaseId,
      `${info.role} on release ${info.releaseId.slice(0, 8)}`
    );

    const page = await journey.loopbackRequest(server.port, {
      host,
      path: "/",
      headers: { cookie: recipientCookie, accept: "text/html" },
    });
    check(
      "app serves",
      page.status === 200 && page.body.includes('<div id="root">'),
      `GET / answered ${page.status}, ${page.body.length} bytes, release ${String(page.headers["x-zenith-release"]).slice(0, 8)}`
    );

    /* --------------------------------- write ------------------------------ */

    const created = await journey.loopbackRequest(server.port, {
      host,
      path: "/_zenith/data/v1/requests",
      method: "POST",
      headers: { cookie: recipientCookie, accept: "application/json", "content-type": "application/json", origin },
      body: JSON.stringify({
        writeId: randomUUID(),
        record: { title: "Standing desk", category: "furniture", quantity: 1 },
      }),
    });
    must("write", created.status === 201, `POST answered ${created.status}`);
    recordId = (JSON.parse(created.body) as { record: { id: string } }).record.id;

    const forged = await journey.loopbackRequest(server.port, {
      host,
      path: "/_zenith/data/v1/requests",
      method: "POST",
      headers: {
        cookie: recipientCookie,
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ writeId: randomUUID(), record: { title: "forged", category: "other" } }),
    });
    check("cross-origin write refused", forged.status === 403, `answered ${forged.status}`);

    /* -------------------------------- conflict ---------------------------- */

    const byOwner = await journey.loopbackRequest(server.port, {
      host,
      path: `/_zenith/data/v1/requests/${recordId}`,
      method: "PATCH",
      headers: { cookie: ownerCookie, accept: "application/json", "content-type": "application/json", origin },
      body: JSON.stringify({ writeId: randomUUID(), expectedVersion: 1, patch: { status: "approved" } }),
    });
    must("second editor writes first", byOwner.status === 200, `PATCH answered ${byOwner.status}`);

    const stale = await journey.loopbackRequest(server.port, {
      host,
      path: `/_zenith/data/v1/requests/${recordId}`,
      method: "PATCH",
      headers: { cookie: recipientCookie, accept: "application/json", "content-type": "application/json", origin },
      body: JSON.stringify({ writeId: randomUUID(), expectedVersion: 1, patch: { priority: "high" } }),
    });
    const conflict = JSON.parse(stale.body) as {
      error?: { code: string; details?: { current?: { version: number; updatedByEmail: string } } };
    };
    check(
      "conflict",
      stale.status === 409 &&
        conflict.error?.code === "stale_version" &&
        conflict.error.details?.current?.version === 2,
      `409 carrying version ${String(conflict.error?.details?.current?.version)} by ${String(conflict.error?.details?.current?.updatedByEmail)}`
    );

    /* --------------------------------- health ----------------------------- */

    const reported = await health.appHealth(app.id, { artifacts: store });
    check(
      "health",
      reported.simulated === false && reported.ok && reported.release?.id === releaseId,
      `${reported.checks.length} real checks, all ${reported.ok ? "green" : "not green"}, simulated=${String(reported.simulated)}`
    );

    /* --------------------------------- backup ----------------------------- */

    const manifest = await backup.createBackup();
    const bundle = fs.readFileSync(path.join(OFF_HOST, ...backup.backupKeyFor(manifest.id).split("/")));
    must(
      "backup",
      bundle.length === manifest.byteSize,
      `${manifest.byteSize} bytes sealed under key ${manifest.keyId}, ledger at sequence ${manifest.revocationSeq}`
    );

    /* --------------------------------- revoke ----------------------------- */

    access.revokeGrant(grantId, OWNER.subject, "acceptance run: access removed after the backup", {
      appId: app.id,
    });
    const drained = await authority.flushOutbox({ kinds: ["revocation_ledger"] });
    must(
      "revoke",
      drained.failed === 0,
      `grant revoked and ${drained.done} ledger line(s) written off-host (0 failures)`
    );

    /* --------------------------------- denied ----------------------------- */

    const afterRevoke = await journey.loopbackRequest(server.port, {
      host,
      path: "/_zenith/data/v1/requests",
      headers: { cookie: recipientCookie, accept: "application/json" },
    });
    check("denied", afterRevoke.status === 401, `the same cookie now answers ${afterRevoke.status}`);

    /* -------------------------------- restore ----------------------------- */

    const report = await backup.restoreBackup({ bundle, into: RESTORE_INTO });
    check(
      "restore",
      report.reconciliation.evidenceComplete &&
        report.reconciliation.applied.some((one) => one.grantId === grantId),
      `into an empty directory; re-applied ${report.reconciliation.applied.length} revocation(s) the snapshot predated`
    );

    /* --------------------------------- assert ----------------------------- */

    data.closeAllAppData();
    authority.closeAuthority();
    process.env.ORRERY_DATA = RESTORE_INTO;
    gateway.resetGatewayDeps();
    authority.openAuthority();

    const restoredGrant = authority.authority().repos.grants.get(grantId);
    check(
      "revoked stays revoked",
      restoredGrant?.state === "revoked",
      `the grant restored from a snapshot that predates the revocation reads ${String(restoredGrant?.state)}`
    );

    const stillOut = await journey.loopbackRequest(server.port, {
      host,
      path: "/",
      headers: { cookie: recipientCookie, accept: "application/json" },
    });
    check(
      "revoked stays out",
      stillOut.status === 401,
      `the restored install answers ${stillOut.status} to the cookie they were holding`
    );

    const records = readRestoredRecords(app.id);
    check(
      "records restored",
      records.length === 1 && records[0].includes("Standing desk"),
      `${records.length} equipment request(s) came back: ${records.join(", ")}`
    );

    // Somebody whose access survived can open the restored app again.
    const freshOwnerCookie = await redeem(journey, access, server.port, host, app.id, OWNER.subject);
    const servedAgain = await journey.loopbackRequest(server.port, {
      host,
      path: "/",
      headers: { cookie: freshOwnerCookie, accept: "text/html" },
    });
    check(
      "restored app serves",
      servedAgain.status === 200 && servedAgain.headers["x-zenith-release"] === releaseId,
      `GET / answered ${servedAgain.status} on release ${String(servedAgain.headers["x-zenith-release"]).slice(0, 8)}`
    );
  } catch (err) {
    check("run", false, err instanceof Error ? err.message : String(err));
  } finally {
    await server.close();
    try {
      data.closeAllAppData();
    } catch {
      /* teardown */
    }
    authority.closeAuthority();
  }

  const failed = rows.filter((row) => !row.ok);
  process.stdout.write(`\nHosted acceptance journey — app ${appId || "(not created)"}\n\n${table()}\n\n`);
  process.stdout.write(
    failed.length === 0
      ? `PASS — ${rows.length} checks, publish through restore, no doubles.\n`
      : `FAIL — ${failed.length} of ${rows.length} checks failed: ${failed.map((row) => row.step).join(", ")}\n`
  );
  return failed.length === 0 ? 0 : 1;
}

/** Mint an exchange and redeem it over the socket, answering with the cookie header. */
async function redeem(
  journey: typeof import("../tests/hosted/acceptance/_journey"),
  access: typeof import("@/lib/hosted/access"),
  port: number,
  host: string,
  appId: string,
  subject: string
): Promise<string> {
  const url = new URL(access.createExchange(appId, subject, `state-${randomUUID()}`).redirect);
  const res = await journey.loopbackRequest(port, {
    host,
    path: `${url.pathname}${url.search}`,
    headers: { accept: "text/html" },
  });
  const value = /__Host-zenith_app=([^;]+)/.exec(res.setCookie.join("\n"))?.[1];
  if (!value) throw new Error(`the callback answered ${res.status} and set no session cookie`);
  return `__Host-zenith_app=${value}`;
}

/** Read the restored app database directly, so the check does not go through a cache. */
function readRestoredRecords(appId: string): string[] {
  const file = path.join(RESTORE_INTO, "apps", encodeURIComponent(appId), "data.sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare("SELECT title, version FROM equipment_requests ORDER BY title")
      .all()
      .map((row) => `${String(row.title)} v${String(row.version)}`);
  } finally {
    db.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(
      `hosted-acceptance failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  });
