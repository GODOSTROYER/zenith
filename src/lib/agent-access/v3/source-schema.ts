import { z } from "zod/v4";
import { EnvTarget, Id, IdempotencyKey } from "./schemas";

const Digest = z.string().regex(/^[a-f0-9]{64}$/).describe("Exact SHA-256 hex digest; never a credential.");
const Commit = z.string().regex(/^[a-f0-9]{40}$/).describe("Exact Git commit SHA, not a moving branch or tag.");
const Version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const GetSourceContextInput = z.strictObject({
  target: EnvTarget,
  runId: Id,
  expectedVersion: Version.optional().describe("The runVersion in the exported handoff. A changed run is refused."),
  expectedDigest: Digest.optional().describe("The handoff digest. A changed context is refused."),
});

export const SubmitSourceProposalInput = z.strictObject({
  target: EnvTarget,
  runId: Id,
  expectedVersion: Version,
  expectedDigest: Digest,
  baseCommit: Commit,
  result: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("commit"), newCommit: Commit }),
    z.strictObject({ kind: z.literal("patch"), patchDigest: Digest }),
  ]),
  changedFiles: z.array(z.strictObject({ path: z.string().min(1).max(500), change: z.enum(["added", "modified", "deleted", "renamed"]) })).min(1).max(100),
  verification: z.array(z.strictObject({ check: z.string().min(1).max(100), status: z.enum(["passed", "failed", "not_run"]), summary: z.string().max(500).optional() })).max(20),
  description: z.string().min(1).max(500),
  idempotencyKey: IdempotencyKey,
});

export type GetSourceContextArgs = z.infer<typeof GetSourceContextInput>;
export type SubmitSourceProposalArgs = z.infer<typeof SubmitSourceProposalInput>;
