/**
 * Production session port for state restore (PROD-DUR-06): hands the EXISTING credential broker an in-process grant and
 * returns its provider session. All provider credential logic (keyless OIDC federation, assumed roles, connection mode and
 * custody checks, revocation, rotation, audit events) stays in the broker; nothing here reads a key or a secret.
 *
 * The claims are not signed, stored or presented to any worker or runner: they exist only inside this process for one
 * callback, like the broker's own verification and read paths use synthetic operation ids. Authority to use them comes from
 * the human approval of the exact restore digest and the caller's role, checked by the service before this is reached. The
 * capability named in the claims (`infrastructure.observe` or `infrastructure.apply`) only selects the broker's observe or
 * deploy role; the AWS session is further narrowed by the explicit session policy to the single state object.
 */
import { randomUUID } from "node:crypto";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { CredentialBroker, ProviderSession } from "@/lib/credentials/types";
import type { StateSessionRequest } from "./state-recovery";

const SESSION_SEC = 600;

export function createStateSessionPort(broker: Pick<CredentialBroker, "withSession">, now: () => Date = () => new Date()) {
  return async function withSession<T>(request: StateSessionRequest, fn: (session: ProviderSession) => Promise<T>): Promise<T> {
    const iat = Math.floor(now().getTime() / 1000);
    const claims: CapabilityGrantClaims = {
      jti: `grt_${randomUUID()}`, iss: "zenith-control", aud: "worker", sub: request.principalId, iat, exp: iat + SESSION_SEC,
      cap: request.purpose === "deploy" ? "infrastructure.apply" : "infrastructure.observe", op: request.correlation, digest: request.digest,
      ws: request.workspaceId, proj: request.projectId, env: request.environmentId,
    };
    return broker.withSession({ connectionId: request.connectionId, grant: Object.freeze(claims), purpose: request.purpose, durationSec: SESSION_SEC,
      ...(request.sessionPolicy ? { sessionPolicy: request.sessionPolicy } : {}) }, fn);
  };
}
