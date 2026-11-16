/**
 * Runner reads without an operation row (C4). Grants are the broker's stateless
 * read grants: signature, audience, capability, workspace, environment and the
 * reserved `read:<jti>` binding are verified before dispatch. No grant is minted
 * here and no operation is fabricated. The read reference stays in the signed
 * envelope for the existing Go protocol; the jobs repository stores a NULL FK.
 *
 * Reuses dispatch's payload validation, runner checks, expiry bounds and signing,
 * and `awaitRunnerJob` for sealed results, timeouts and cancellation. AWS RPC
 * actions remain subject to the runner's per-capability action allowlist (POST
 * is also used for AWS reads). Secret-shape scanning is defence in depth only.
 * Tests use a fake agent and real PGlite SQL; no live cloud read is claimed.
 */
import { capability, isCapability } from "@/lib/capabilities/catalog";
import { assertNoSecretValues, isSecretKey } from "@/lib/controlplane/db/secrets";
import { GrantVerificationError } from "@/lib/credentials/errors";
import { verifyCapabilityGrant } from "@/lib/credentials/grants";
import { isAllowed as isOciRequestAllowed } from "@/lib/providers/oci/allowlist";
import { DispatchError, enqueueRunnerJob } from "@/lib/runners/dispatch";
import { PayloadError, validateRunnerPayload, type OciHttpPayload } from "@/lib/runners/payloads";
import { getRunnerRuntime, type RunnerRuntime } from "@/lib/runners/runtime";
import { isValidId, RUNNER_JOB_KINDS, type RunnerJobKind } from "@/lib/runners/types";

export interface EnqueueReadJobInput {
  workspaceId: string;
  environmentId: string;
  runnerId: string;
  /** the provider connection the read acts through; its binding is re-proved at dispatch */
  connectionId?: string;
  capability: string;
  kind: RunnerJobKind;
  payload: unknown;
  grant: string;
  timeoutSec?: number;
  maxOutputBytes?: number;
}

function readPayload(input: EnqueueReadJobInput): unknown {
  let payload: unknown;
  try {
    payload = validateRunnerPayload(input.kind, input.payload);
  } catch (error) {
    if (error instanceof PayloadError) throw new DispatchError("invalid_payload", "The read-job payload is malformed.");
    throw error;
  }
  const p = payload as Record<string, unknown>;
  if (input.kind === "tofu.run" && p.command === "apply")
    throw new DispatchError("invalid_payload", "A read job cannot apply infrastructure.");
  if (input.kind === "k8s.http" && p.method !== "GET")
    throw new DispatchError("invalid_payload", "A Kubernetes read job requires GET.");
  if (input.kind === "oci.http" && !isOciRequestAllowed(input.capability, payload as OciHttpPayload))
    throw new DispatchError("invalid_payload", "The OCI request is outside this read capability's allowlist.");
  if (input.kind === "aws.http" && !["GET", "HEAD", "POST"].includes(String(p.method)))
    throw new DispatchError("invalid_payload", "An AWS read job requires GET, HEAD or an allowlisted RPC POST.");
  if (p.headers && Object.keys(p.headers).some((key) => isSecretKey(key) || /^(?:authorization|proxy-authorization|cookie|set-cookie)$/i.test(key)))
    throw new DispatchError("invalid_payload", "Read jobs cannot carry credential headers.");
  try {
    assertNoSecretValues(payload);
    if (typeof p.bodyB64 === "string") assertNoSecretValues(Buffer.from(p.bodyB64, "base64").toString("utf8"));
    if (Array.isArray(p.files)) {
      for (const file of p.files as { contentB64: string }[])
        assertNoSecretValues(Buffer.from(file.contentB64, "base64").toString("utf8"));
    }
  } catch {
    throw new DispatchError("invalid_payload", "The read-job payload cannot contain secret values or exceed scan limits.");
  }
  return payload;
}

/** Queue a non-mutating job. Await its id with the existing `awaitRunnerJob`. */
export async function enqueueReadJob(input: EnqueueReadJobInput, runtime?: RunnerRuntime): Promise<string> {
  for (const value of [input.workspaceId, input.environmentId, input.runnerId])
    if (!isValidId(value)) throw new DispatchError("invalid_input", "Workspace, environment and runner ids must be valid ids.");
  if (!isCapability(input.capability) || capability(input.capability).mutates)
    throw new DispatchError("invalid_input", "Read jobs require a catalogued non-mutating capability.");
  if (!(RUNNER_JOB_KINDS as readonly string[]).includes(input.kind))
    throw new DispatchError("invalid_input", "The read-job kind is not supported.");
  const payload = readPayload(input);
  const rt = runtime ?? (await getRunnerRuntime());
  let claims;
  try {
    claims = await verifyCapabilityGrant(input.grant, {
      audience: `runner:${input.runnerId}`,
      expectedCapability: input.capability,
      keys: await rt.verificationKeys(),
      now: new Date(rt.now()),
      ...(rt.grantRevoked ? { isRevoked: (jti: string) => rt.grantRevoked!(input.workspaceId, jti) } : {}),
    });
  } catch (error) {
    if (error instanceof GrantVerificationError)
      throw new DispatchError("grant_invalid", "The read capability grant was refused.");
    throw error;
  }
  if (claims.ws !== input.workspaceId || claims.env !== input.environmentId)
    throw new DispatchError("grant_invalid", "The read grant does not bind this workspace and environment.");
  if (claims.op !== `read:${claims.jti}` || !isValidId(claims.op))
    throw new DispatchError("grant_invalid", "The grant does not have the broker's read binding.");
  return enqueueRunnerJob({
    workspaceId: input.workspaceId,
    runnerId: input.runnerId,
    ...(input.connectionId !== undefined ? { bindingConnectionId: input.connectionId } : {}),
    operationId: claims.op,
    capability: input.capability,
    kind: input.kind,
    payload,
    grant: input.grant,
    timeoutSec: input.timeoutSec,
    maxOutputBytes: input.maxOutputBytes,
  }, rt);
}
