/**
 * Shared fixtures for the W8 (ops) suites: real apps, real grants, real
 * artifacts, real records.
 *
 * Nothing here mocks anything. Every helper writes through the real
 * repositories, the real artifact store and the real per-app tracker store, so
 * a backup test is backing up a database that was actually written to and a
 * health test is verifying an artifact whose bytes are actually on disk.
 *
 * It lives under `tests/hosted/backup/` because that is inside W8's exclusive
 * paths; the other W8 suites import it from here.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { RECIPE_V1, type ArtifactProvenance, type DataContext } from "@/lib/hosted/contracts";
import type { Authority } from "@/lib/hosted/authority";
import { FsArtifactStore } from "@/lib/hosted/artifacts";
import { openAppData } from "@/lib/hosted/data";

export const uuid = (): string => randomUUID();
export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
export const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

/** The three identities the hosted fixtures use, plus one stranger. */
export const OWNER = { subject: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
export const EDITOR = { subject: "22222222-2222-4222-8222-222222222222", email: "ed@example.test" };
export const VIEWER = { subject: "33333333-3333-4333-8333-333333333333", email: "vi@example.test" };

/** Provenance good enough for the foreign keys and honest about being a fixture. */
export function provenance(jobId: string): ArtifactProvenance {
  return {
    sourceDigest: sha256Hex(`source-${jobId}`),
    sourceKind: "tarball",
    jobId,
    recipe: RECIPE_V1,
    contractVersion: 1,
    schemaVersion: 1,
    builtBy: "recipe-local",
    buildBoundary: "test fixture: no build ran",
    builtAt: iso(),
  };
}

/** Insert an app. */
export function seedApp(
  a: Authority,
  opts: { slug?: string; workspaceId?: string; createdBy?: string } = {}
) {
  const slug = opts.slug ?? `app-${uuid().slice(0, 8)}`;
  return a.tx(() =>
    a.repos.apps.insert({
      id: uuid(),
      workspaceId: opts.workspaceId ?? "ws-one",
      slug,
      name: `App ${slug}`,
      createdBy: opts.createdBy ?? OWNER.subject,
      runtime: "local",
    })
  );
}

/** Insert a grant, active by default. */
export function seedGrant(
  a: Authority,
  appId: string,
  who: { subject: string; email: string },
  role: "owner" | "editor" | "viewer" = "owner"
) {
  return a.tx(() =>
    a.repos.grants.insert({
      id: uuid(),
      appId,
      subject: who.subject,
      email: who.email,
      role,
      grantedBy: OWNER.subject,
    })
  );
}

/** Open a live session against a grant, so a revocation has something to terminate. */
export function seedSession(a: Authority, appId: string, grantId: string, subject: string) {
  return a.tx(() =>
    a.repos.sessions.insert({
      id: sha256Hex(`session-${grantId}-${uuid()}`),
      appId,
      subject,
      grantId,
      expiresAt: iso(12 * 60 * 60_000),
    })
  );
}

/**
 * Build a real artifact: write a tiny output tree, store it content-addressed,
 * index it in the authority. Returns the digest and the store it lives in.
 */
export async function seedArtifact(
  a: Authority,
  root: string,
  opts: { marker?: string; jobId?: string } = {}
): Promise<{ digest: string; store: FsArtifactStore }> {
  const jobId = opts.jobId ?? uuid();
  const outputDir = fs.mkdtempSync(path.join(path.dirname(root), "artifact-src-"));
  fs.writeFileSync(
    path.join(outputDir, "index.html"),
    `<!doctype html><title>${opts.marker ?? jobId}</title><script src="/assets/app.js"></script>\n`
  );
  fs.mkdirSync(path.join(outputDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(outputDir, "assets", "app.js"), `export const marker = ${JSON.stringify(opts.marker ?? jobId)};\n`);

  const store = new FsArtifactStore(root);
  const artifact = await store.put(outputDir, provenance(jobId));
  fs.rmSync(outputDir, { recursive: true, force: true });

  a.tx(() =>
    a.repos.artifacts.insert({
      digest: artifact.digest,
      byteSize: artifact.byteSize,
      fileCount: artifact.fileCount,
      provenance: artifact.provenance,
    })
  );
  return { digest: artifact.digest, store };
}

/** Insert a release for an app and make it the active one. */
export function seedActiveRelease(a: Authority, appId: string, digest: string) {
  return a.tx(() => {
    const release = a.repos.releases.insert({
      id: uuid(),
      appId,
      number: a.repos.releases.nextNumber(appId),
      artifactDigest: digest,
      jobId: uuid(),
      runtime: "local",
    });
    a.repos.releases.setStatus(release.id, "active", { activatedAt: iso() });
    const app = a.repos.apps.get(appId);
    a.repos.apps.setActiveRelease(appId, release.id, app?.activeFence ?? 0);
    return release;
  });
}

/** A data context for the tracker store. */
export const dataContext = (
  appId: string,
  who: { subject: string; email: string } = OWNER,
  role: "owner" | "editor" | "viewer" = "owner",
  releaseId = "test-release"
): DataContext => ({ appId, subject: who.subject, email: who.email, role, releaseId });

/** Write one equipment request through the real store. */
export async function seedRecord(
  appId: string,
  opts: { title?: string; who?: { subject: string; email: string }; quantity?: number } = {}
) {
  const data = openAppData(appId);
  const { record } = await data.store.create(dataContext(appId, opts.who ?? OWNER), {
    writeId: uuid(),
    record: {
      title: opts.title ?? `Request ${uuid().slice(0, 8)}`,
      category: "laptop",
      quantity: opts.quantity ?? 1,
    },
  });
  return record;
}
