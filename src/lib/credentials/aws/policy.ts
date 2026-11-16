/**
 * Validation for AWS inline session policies passed to STS `Policy`.
 *
 * A session policy can only NARROW a role (effective permissions are the
 * intersection of the role's policies and the session policy), so the risk in
 * accepting a caller-supplied one is not privilege escalation — it is a policy
 * that is broken (STS rejects it after the token exchange was already made) or
 * pointlessly permissive (an `Allow *` on `*` narrows nothing and hides the
 * fact that no narrowing was intended). We reject both up front, before any
 * STS call, with a message naming the problem.
 *
 * Limits (AWS): the plaintext of the policy (plus any managed-policy ARNs)
 * must not exceed 2,048 characters, and only characters U+0020–U+00FF plus
 * tab/LF/CR are allowed. We measure the COMPACT serialisation, the form we
 * actually send.
 */

export const SESSION_POLICY_MAX_CHARS = 2048;
const MAX_STATEMENTS = 20;

export class SessionPolicyError extends Error {
  readonly code = "session_policy_invalid";
  constructor(message: string) {
    super(message);
    this.name = "SessionPolicyError";
  }
}

const toArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const isWildcardAction = (a: unknown): boolean => a === "*" || a === "*:*";

/** Validate and return the compact JSON string to send as STS `Policy`. */
export function validateSessionPolicy(policy: unknown): string {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new SessionPolicyError("A session policy must be a JSON object.");
  }
  const doc = policy as Record<string, unknown>;
  if (doc.Version !== "2012-10-17") {
    throw new SessionPolicyError('A session policy must declare "Version": "2012-10-17".');
  }
  const statements = toArray(doc.Statement);
  if (statements.length === 0) throw new SessionPolicyError("A session policy must contain at least one statement.");
  if (statements.length > MAX_STATEMENTS) {
    throw new SessionPolicyError(`A session policy may contain at most ${MAX_STATEMENTS} statements.`);
  }
  for (const [i, raw] of statements.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new SessionPolicyError(`Statement ${i} must be an object.`);
    }
    const s = raw as Record<string, unknown>;
    if (s.Effect !== "Allow" && s.Effect !== "Deny") {
      throw new SessionPolicyError(`Statement ${i} must have Effect "Allow" or "Deny".`);
    }
    if ("Principal" in s || "NotPrincipal" in s) {
      throw new SessionPolicyError(`Statement ${i}: session policies do not take a Principal.`);
    }
    const actions = toArray(s.Action);
    const resources = toArray(s.Resource);
    if (s.Effect === "Allow") {
      if ("NotAction" in s || "NotResource" in s) {
        throw new SessionPolicyError(`Statement ${i}: Allow statements may not use NotAction or NotResource.`);
      }
      if (actions.length === 0) throw new SessionPolicyError(`Statement ${i}: an Allow statement needs an Action.`);
      if (resources.length === 0) throw new SessionPolicyError(`Statement ${i}: an Allow statement needs a Resource.`);
      if (actions.some(isWildcardAction) && resources.some((r) => r === "*")) {
        throw new SessionPolicyError(
          `Statement ${i}: "Action": "*" with "Resource": "*" grants everything and narrows nothing; scope it or omit the session policy.`
        );
      }
    }
    for (const a of actions) {
      if (typeof a !== "string" || !/^(?:\*|[A-Za-z0-9-]+:[A-Za-z0-9*?]+|\*:\*)$/.test(a)) {
        throw new SessionPolicyError(`Statement ${i}: invalid Action.`);
      }
    }
    for (const r of resources) {
      if (typeof r !== "string" || r.length === 0 || r.length > 1224) {
        throw new SessionPolicyError(`Statement ${i}: invalid Resource.`);
      }
    }
  }
  const compact = JSON.stringify(policy);
  if (!/^[\t\n\r -ÿ]+$/.test(compact)) {
    throw new SessionPolicyError("A session policy may only contain characters U+0020–U+00FF.");
  }
  if (compact.length > SESSION_POLICY_MAX_CHARS) {
    throw new SessionPolicyError(
      `The session policy is ${compact.length} characters; AWS allows at most ${SESSION_POLICY_MAX_CHARS}.`
    );
  }
  return compact;
}
