/** Real local Supabase browser + the normal migration-approval route + owning PostgreSQL rows. */
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { createPlatformReleaseStore } from "@/lib/controlplane/db/repos/release-pipelines";
import { createBuildRecordVerifier } from "@/lib/platform/release-safety";
import { ReleaseSafetyService } from "@/lib/release-safety";
import { seedApprovedOperation, user } from "../controlplane/_support/harness";

type Identity = { authUserId: string; email: string; password: string; workspaceId: string };
type Fixture = { origin: string; identities: Identity[] };
const enabled = process.env.ZENITH_MFA_BROWSER === "1";
const gated = describe.skipIf(!enabled);
const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`LIFE-10 browser migration approval requires ${name}.`); return value; };
let browser: Browser, fixture: Fixture, platform: PlatformDbHandle;
let releaseId = "", bindingDigest = "", workspaceId = "", serviceAddress = "";

function totp(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.toUpperCase().replace(/=+$/, "")) {
    const n = alphabet.indexOf(char);
    if (n < 0) throw new Error("Auth returned an invalid TOTP setup key.");
    bits += n.toString(2).padStart(5, "0");
  }
  const bytes = Buffer.from(bits.match(/.{8}/g)?.map((byte) => parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", bytes).update(counter).digest();
  const start = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(start) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function loginAtAal2(identity: Identity): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/login`);
  await page.getByLabel("Email", { exact: true }).fill(identity.email);
  await page.getByLabel("Password", { exact: true }).fill(identity.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await page.goto(`${fixture.origin}/platform`);
  expect(await page.getByRole("link", { name: "Verify your authenticator", exact: true }).count()).toBeGreaterThan(0);
  await page.goto(`${fixture.origin}/account/mfa/enrol?next=%2Fplatform`);
  await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
  const secret = page.getByLabel("Setup key", { exact: true });
  await secret.waitFor();
  const code = totp(await secret.inputValue());
  const input = page.getByLabel("Six-digit authenticator code", { exact: true });
  await input.focus(); await input.fill(code); await input.press("Enter");
  await page.getByRole("heading", { name: "Authenticator verified", exact: true }).waitFor();
  const selected = await page.evaluate(async (id) => {
    const response = await fetch("/api/workspace/select", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: id }) });
    return { status: response.status, body: await response.json() };
  }, identity.workspaceId);
  expect(selected.status).toBe(200);
  return { context, page };
}

async function postApproval(page: Page, id: string, binding: string) {
  return page.evaluate(async ({ id, binding, workspaceId }) => {
    const response = await fetch(`/api/platform/v1/releases/${encodeURIComponent(id)}/approve-migration`, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", "x-zenith-workspace": workspaceId },
      body: JSON.stringify({ bindingDigest: binding }),
    });
    return { status: response.status, body: await response.json() };
  }, { id, binding, workspaceId });
}

gated("LIFE-10 browser migration approval route", () => {
  beforeAll(async () => {
    const fixtureFile = required("ZENITH_LIFE10_BROWSER_FIXTURES_FILE");
    const executablePath = required("ZENITH_MFA_BROWSER_EXECUTABLE");
    const dbUrl = required("ZENITH_TEST_PLATFORM_PG_URL");
    const appDbUrl = process.env.ZENITH_PLATFORM_DB_URL?.trim() || process.env.SUPABASE_DB_URL?.trim();
    if (!appDbUrl || appDbUrl !== dbUrl) throw new Error("The browser app and test seed must use the same owning PostgreSQL URL.");
    const dbTarget = new URL(dbUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(dbTarget.hostname)) throw new Error("This case accepts a disposable loopback PostgreSQL target only.");
    fixture = JSON.parse(await readFile(fixtureFile, "utf8")) as Fixture;
    const sharedFixtureFile = required("ZENITH_MFA_BROWSER_FIXTURES_FILE");
    const sharedFixture = JSON.parse(await readFile(sharedFixtureFile, "utf8")) as Fixture;
    const appOrigin = new URL(fixture.origin);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(appOrigin.hostname) || appOrigin.origin !== fixture.origin) throw new Error("This case accepts the exact loopback J1 origin only.");
    if (fixture.identities?.length !== 2 || fixture.identities.some((identity) => !/^[0-9a-f-]{36}$/i.test(identity.authUserId) || !identity.email || !identity.password || !identity.workspaceId)) throw new Error("The private MFA fixture must identify two real Auth users with their existing login details and workspace.");
    if (sharedFixture.identities?.some((shared) => fixture.identities.some((life10) => life10.email.trim().toLowerCase() === shared.email.trim().toLowerCase() || (shared.authUserId && life10.authUserId.toLowerCase() === shared.authUserId.toLowerCase())))) throw new Error("LIFE-10 requires two Auth users separate from the shared MFA browser fixture; do not reuse or reset its factors.");
    if (fixture.identities[0].workspaceId !== fixture.identities[1].workspaceId) throw new Error("Both real MFA users must be members of the same disposable workspace.");
    [workspaceId] = [fixture.identities[0].workspaceId];
    const environmentId = required("ZENITH_J6_ENVIRONMENT_ID");
    if (process.env.ZENITH_J6_WORKSPACE_ID && process.env.ZENITH_J6_WORKSPACE_ID !== workspaceId) throw new Error("The Auth and J6 fixtures must name the same workspace.");
    platform = await openPlatformDb({ kind: "postgres", url: dbUrl, migrate: false, max: 2 });
    const store = createPlatformReleaseStore(platform);
    const operated = await store.listRuns(workspaceId, { environmentId, operationId: required("ZENITH_J6_OPERATION_ID"), limit: 2 });
    if (operated.length !== 1 || operated[0].state !== "readback_verified" || !operated[0].imageUri.endsWith(`@${operated[0].imageDigest}`)) throw new Error("Seed requires the exact completed, digest-pinned J6 operated release in this workspace/environment.");
    const image = operated[0]; serviceAddress = image.serviceAddress;
    const requester = fixture.identities[0];
    const operation = await seedApprovedOperation(platform, workspaceId, {
      requester: user(requester.authUserId, requester.email),
      proposal: {
        capability: "deployment.deploy",
        scope: { workspaceId, ...(image.projectId ? { projectId: image.projectId } : {}), environmentId },
        input: { serviceAddress, imageDigest: image.imageDigest },
        summary: "Seed the blocked migration-approval route state from the owning operation schema.",
        details: ["No deployment is dispatched by this route test."],
        risk: "high",
      },
    });
    const seedSafety = new ReleaseSafetyService({ store, verifiers: [createBuildRecordVerifier(platform)], minProvenance: "pinned_digest" });
    const commandDigest = createHash("sha256").update("life10-browser-fixture:/app/migrate").digest("hex");
    let refusal: unknown;
    try {
      await seedSafety.begin({
        workspaceId, projectId: image.projectId, environmentId, operationId: operation.operation.id, revisionId: image.revisionId,
        serviceAddress, provider: "kubernetes", nodeKind: "container_service", kind: "deploy",
        imageUri: image.imageUri, imageDigest: image.imageDigest, origin: "pinned", requestedBy: requester.authUserId,
        migration: { commandDigest, declared: "contract" },
      });
    } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: "migration_approval_required" });
    const blocked = await store.findRun(workspaceId, operation.operation.id, serviceAddress, "deploy");
    expect(blocked).toMatchObject({ state: "blocked_approval", requestedBy: requester.authUserId, migration: { class: "contract", status: "pending_approval" } });
    releaseId = blocked!.id; bindingDigest = blocked!.migration.bindingDigest!;
    expect(bindingDigest).toMatch(/^[0-9a-f]{64}$/);
    browser = await (await import("playwright-core")).chromium.launch({ executablePath, headless: true });
  }, 120_000);
  afterAll(async () => { await browser?.close(); await platform?.close(); });

  it("denies requester and records one exact-bound approval from a distinct real admin", async () => {
    const [requester, approver] = fixture.identities;
    const requesterSession = await loginAtAal2(requester);
    try {
      await requesterSession.page.goto(`${fixture.origin}/platform/releases/${encodeURIComponent(releaseId)}`);
      const approveButton = requesterSession.page.getByRole("button", { name: "Approve contract migration", exact: true });
      expect(await approveButton.isDisabled()).toBe(true);
      expect(await requesterSession.page.getByText("The person who requested this release cannot approve its migration.", { exact: true }).isVisible()).toBe(true);
      const refused = await postApproval(requesterSession.page, releaseId, bindingDigest);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ error: { code: "separation_of_duties" } });
      const rows = await platform.query("select id from platform.release_migration_approvals where workspace_id=$1 and run_id=$2", [workspaceId, releaseId]);
      expect(rows).toHaveLength(0);
    } finally { await requesterSession.context.close(); }

    const approverSession = await loginAtAal2(approver);
    try {
      await approverSession.page.goto(`${fixture.origin}/platform/releases/${encodeURIComponent(releaseId)}`);
      const approveButton = approverSession.page.getByRole("button", { name: "Approve contract migration", exact: true });
      expect(await approveButton.isEnabled()).toBe(true);
      const routePath = `/api/platform/v1/releases/${encodeURIComponent(releaseId)}/approve-migration`;
      const responsePromise = approverSession.page.waitForResponse((response) => response.url().includes(routePath) && response.request().method() === "POST");
      await approveButton.click();
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      const first = await response.json() as { approval: { id: string; runId: string; class: string } };
      expect(first.approval).toMatchObject({ runId: releaseId, class: "contract" });
      expect(await approverSession.page.getByRole("status").filter({ hasText: "Approval recorded. Deploy again to run the migration." }).isVisible()).toBe(true);

      // The route's current contract is row-level idempotency: replay returns the same approval.
      // It appends a same-state release event, so the test does not assert a no-op event history.
      const replay = await postApproval(approverSession.page, releaseId, bindingDigest);
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ approval: { id: first.approval.id, runId: releaseId, class: "contract" } });
      const rows = await platform.query<{ id: string; approved_by: string; requested_by: string; binding_digest: string; consumed_at: string | null }>(
        "select id, approved_by, requested_by, binding_digest, consumed_at from platform.release_migration_approvals where workspace_id=$1 and run_id=$2",
        [workspaceId, releaseId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: first.approval.id, approved_by: approver.authUserId, requested_by: requester.authUserId, binding_digest: bindingDigest, consumed_at: null });
      const release = await createPlatformReleaseStore(platform).getRun(workspaceId, releaseId);
      expect(release).toMatchObject({ state: "blocked_approval", migration: { class: "contract", status: "approved", approvalId: first.approval.id } });
      const events = await createPlatformReleaseStore(platform).listEvents(workspaceId, releaseId);
      expect(events.some((event) => event.to === "deployed" || event.to === "migrated")).toBe(false);
    } finally { await approverSession.context.close(); }
  }, 240_000);
});
