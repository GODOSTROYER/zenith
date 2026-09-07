/**
 * What a publish *is*, rendered as one canonical object so two requests can be
 * compared without comparing megabytes.
 *
 * The idempotency key of a publish is the client's job UUID; the thing it is
 * checked against is the SHA-256 of this intent. A tarball therefore enters the
 * hash as the SHA-256 of its bytes rather than as the bytes themselves — the
 * comparison is exact either way, and a 5 MB submission does not have to be
 * held in memory, re-encoded and re-hashed by `hashIntent`'s canonical
 * JSON walk to answer "is this the same publish you already admitted?".
 *
 * A fixture enters as its name. The allowlist below is the whole set: a
 * request naming anything else is `unsupported_source`, not a path this module
 * resolves. That is the point — a `{ kind: "fixture", name }` source is a path
 * on the control host, and the only safe way to accept one from a request is
 * to never take the path from the request at all.
 *
 * Workstream W7 (hosted R3).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hashIntent } from "@/lib/hosted/authority";
import { platformRoot } from "@/lib/hosted/build";
import { HostedError, SOURCE_LIMITS, type Subject } from "@/lib/hosted/contracts";

/** Every fixture a publish may name, and where it lives relative to the repository root. */
export const FIXTURES: Record<string, string> = {
  "tracker-app": "fixtures/tracker-app",
  "minimal-app": "fixtures/hosted/minimal-app",
};

/**
 * The `source` a publish request carries. Anything else is refused before
 * admission.
 *
 * `filename` is accepted and kept for display — an owner reading a job wants to
 * know which archive they uploaded — and deliberately left out of the intent
 * hash below. A publish is the bytes; renaming the file on the way in does not
 * make it a different operation, and hashing the name would turn a retry from
 * a differently-named download into an `idempotency_conflict`.
 */
export const PublishSource = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tarball"),
      base64: z.string().min(1),
      filename: z.string().trim().max(200).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("fixture"), name: z.string().trim().min(1).max(80) }).strict(),
]);
export type PublishSource = z.infer<typeof PublishSource>;

const FIXTURE_FIX = `Send { "kind": "fixture", "name": "<one of ${Object.keys(FIXTURES).join(", ")}>" }, or submit your own source as { "kind": "tarball", "base64": "…" }.`;

/** SHA-256 hex over a buffer. The tarball's identity inside an intent. */
export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The directory a named fixture resolves to.
 *
 * Resolved from the platform root and checked against the allowlist by name,
 * so no part of the request reaches the filesystem as a path.
 */
export function fixtureDirectory(name: string): string {
  const relative = FIXTURES[name];
  if (!relative)
    throw new HostedError("unsupported_source", `"${name}" is not a source fixture this install ships.`, {
      fix: FIXTURE_FIX,
      details: { available: Object.keys(FIXTURES) },
    });
  const dir = path.join(platformRoot(), ...relative.split("/"));
  if (!fs.existsSync(dir))
    throw new HostedError(
      "unsupported_source",
      `The fixture "${name}" is missing from this install (expected ${relative}).`,
      { fix: "Publish your own source as a tarball, or restore the fixtures directory from the repository." }
    );
  return dir;
}

/**
 * Decode a submitted tarball. Refuses anything that is not base64, and
 * anything larger than the decompression ceiling the source contract sets —
 * the point at which a submission stops being a source package and starts
 * being a denial of service.
 */
export function decodeTarball(base64: string): Buffer {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0)
    throw new HostedError("unsupported_source", "The submitted tarball decoded to zero bytes.", {
      fix: "Send the gzipped tar of your source directory, base64-encoded, in `source.base64`.",
    });
  if (bytes.length > SOURCE_LIMITS.maxDecompressedBytes)
    throw new HostedError(
      "body_too_large",
      `The submitted tarball is ${bytes.length} bytes; this install accepts at most ${SOURCE_LIMITS.maxDecompressedBytes}.`,
      { fix: "Remove build output, images and anything under node_modules from the archive, then submit it again." }
    );
  return bytes;
}

/** What `publishIntent` was asked about. */
export interface PublishIntentInput {
  appId: string;
  workspaceId: string;
  actor: Subject;
  source: PublishSource;
}

/** The canonical intent, its hash, and the bytes admission has to persist. */
export interface PublishIntent {
  intent: Record<string, unknown>;
  hash: string;
  /** Present for a tarball: the decoded bytes and their digest. */
  tarball?: { bytes: Buffer; sha256: string };
}

/**
 * The canonical publish intent and its SHA-256.
 *
 * Everything that makes this publish what it is: who asked, where, for which
 * app, and exactly which bytes. Two requests whose intents hash the same are
 * the same operation; two that do not are two operations, and sharing one job
 * id between them is `idempotency_conflict`.
 */
export function publishIntent(input: PublishIntentInput): PublishIntent {
  if (input.source.kind === "fixture") {
    // Resolved here so an unknown fixture is refused at admission rather than
    // by a worker three phases later.
    fixtureDirectory(input.source.name);
    const intent = canonical(input, { kind: "fixture", name: input.source.name });
    return { intent, hash: hashIntent(intent) };
  }
  const bytes = decodeTarball(input.source.base64);
  const digest = sha256(bytes);
  const source = { kind: "tarball", sha256: digest, bytes: bytes.length };
  return {
    intent: canonical(input, source),
    hash: hashIntent(canonical(input, source)),
    tarball: { bytes, sha256: digest },
  };
}

/** The rollback intent: which release this app is being put back onto. */
export function rollbackIntent(input: {
  appId: string;
  workspaceId: string;
  actor: Subject;
  releaseId: string;
}): { intent: Record<string, unknown>; hash: string } {
  const intent = {
    kind: "rollback",
    contract: 1,
    appId: input.appId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    releaseId: input.releaseId,
  };
  return { intent, hash: hashIntent(intent) };
}

/** The suspend/resume intent: the state change and the reason recorded with it. */
export function stateIntent(input: {
  kind: "suspend" | "resume";
  appId: string;
  workspaceId: string;
  actor: Subject;
  reason?: string;
}): { intent: Record<string, unknown>; hash: string } {
  const intent = {
    kind: input.kind,
    contract: 1,
    appId: input.appId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    reason: input.reason ?? null,
  };
  return { intent, hash: hashIntent(intent) };
}

const canonical = (
  input: PublishIntentInput,
  source: Record<string, unknown>
): Record<string, unknown> => ({
  kind: "publish",
  contract: 1,
  appId: input.appId,
  workspaceId: input.workspaceId,
  actor: input.actor,
  source,
});
