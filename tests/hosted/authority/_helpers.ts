/**
 * Row builders shared by the authority tests: the smallest legal `apps`,
 * `artifacts` and `releases` rows the foreign keys demand, so each test can
 * say only the thing it is about.
 *
 * Nothing here mocks SQLite. Every helper writes through the real repositories
 * inside a real transaction against a real file.
 *
 * Every one of them returns a Promise, because every repository call does:
 * `const app = await seedApp(a)`.
 */
import { createHash, randomUUID } from "node:crypto";
import { RECIPE_V1, type ArtifactProvenance } from "@/lib/hosted/contracts";
import type { Authority } from "@/lib/hosted/authority";

/** A fresh UUID, the shape every id in this authority uses. */
export const uuid = (): string => randomUUID();

/** SHA-256 hex — what token, code and session columns store instead of the value. */
export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/** An ISO timestamp offset from now, for expiry and lease boundaries. */
export const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

/** A 64-character hex digest derived from a readable seed. */
export const digestOf = (seed: string): string => sha256Hex(seed);

/** Provenance good enough for the foreign keys; W2 writes the real thing. */
export function provenance(jobId: string): ArtifactProvenance {
  return {
    sourceDigest: digestOf(`source-${jobId}`),
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

/** Insert an app and answer with it. */
export function seedApp(
  a: Authority,
  opts: { slug?: string; workspaceId?: string; createdBy?: string } = {}
) {
  const slug = opts.slug ?? `app-${uuid().slice(0, 8)}`;
  return a.tx((repos) =>
    repos.apps.insert({
      id: uuid(),
      workspaceId: opts.workspaceId ?? "ws-one",
      slug,
      name: `App ${slug}`,
      createdBy: opts.createdBy ?? "11111111-1111-4111-8111-111111111111",
      runtime: "local",
    })
  );
}

/** Insert an active grant on an app. */
export function seedGrant(
  a: Authority,
  appId: string,
  subject: string,
  role: "owner" | "editor" | "viewer" = "owner"
) {
  return a.tx((repos) =>
    repos.grants.insert({
      id: uuid(),
      appId,
      subject,
      email: `${subject.slice(0, 8)}@example.test`,
      role,
      grantedBy: subject,
    })
  );
}

/** Insert an artifact row and answer with its digest. */
export async function seedArtifact(a: Authority, seed = uuid()): Promise<string> {
  const digest = digestOf(seed);
  await a.tx((repos) =>
    repos.artifacts.insert({
      digest,
      byteSize: 1024,
      fileCount: 3,
      provenance: provenance(seed),
    })
  );
  return digest;
}

/** Insert an artifact and a candidate release for an app, and answer with the release. */
export async function seedRelease(a: Authority, appId: string, jobId = uuid()) {
  const digest = await seedArtifact(a, `${appId}-${jobId}`);
  return a.tx(async (repos) =>
    repos.releases.insert({
      id: uuid(),
      appId,
      number: await repos.releases.nextNumber(appId),
      artifactDigest: digest,
      jobId,
      runtime: "local",
    })
  );
}
