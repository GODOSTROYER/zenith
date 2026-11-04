/**
 * Defence in depth against secret material reaching the control store.
 *
 * The rule (invariant 2 of `controlplane/types.ts`) is that a value never gets
 * here in the first place: callers hold references (`vault:…`, ARNs, secret
 * names). These checks are the last line, not the mechanism, and they are
 * deliberately conservative in two different ways:
 *
 *  - `assertNoSecretKeys` — for **structured configuration whose shape we own**
 *    (provider connection config, registration-token bindings). A member named
 *    like `secretAccessKey`, `password`, `token`, `privateKey`, … is refused
 *    outright, whatever its value. A reference-typed name (`…Ref`, `…Arn`,
 *    `…Name`, `…Path`, e.g. `credentialRef`) is allowed, because a reference is
 *    exactly what belongs there.
 *  - `assertNoSecretValues` — for **free-form data** (event `data`, evidence
 *    summaries, operation results): only literal secret *values* are refused
 *    (PEM private keys, JWT-shaped strings, AWS access key ids, bearer
 *    credentials, `scheme://user:password@host` URLs, well-known token
 *    prefixes). Key names are not checked there — `tokenCount` in a usage event
 *    is not a secret and refusing to log it would only cost availability.
 *
 * Neither is a redactor and neither proves absence: a high-entropy string with
 * no recognisable shape passes. Errors name the path of the offending member,
 * never its value.
 */
import { ControlStoreError } from "./errors";

const MAX_DEPTH = 16;
const MAX_NODES = 20_000;
const MAX_STRING_SCAN = 200_000;

const SECRET_KEY_PARTS = ["secret", "password", "passwd", "passphrase", "token", "privatekey", "apikey", "accesskey", "sessionkey", "bearer"];
const REFERENCE_SUFFIXES = ["ref", "arn", "name", "path"];

/** True when the member name looks like it holds secret material. */
export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!SECRET_KEY_PARTS.some((part) => k.includes(part))) return false;
  return !REFERENCE_SUFFIXES.some((suffix) => k.endsWith(suffix));
}

const VALUE_PATTERNS: readonly [RegExp, string][] = [
  [/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/, "a PEM private key"],
  [/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/, "a JWT-shaped credential"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i, "a bearer credential"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@[^\s/]+/i, "a URL with an embedded password"],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}\b/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/, "a GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, "a Slack token"],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/, "a payment provider secret key"],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/, "a model provider API key"],
];

function refuse(path: string, what: string): never {
  throw new ControlStoreError(
    "secret_material",
    `Refusing to store ${what} at ${path || "<root>"}. The control store holds references (vault:…, ARNs, secret names), never secret values.`,
    { path }
  );
}

function walk(value: unknown, path: string, checkKeys: boolean, state: { nodes: number }, depth: number): void {
  if (++state.nodes > MAX_NODES) throw new ControlStoreError("invalid_input", "Structured value is too large to store.", { path });
  if (depth > MAX_DEPTH) throw new ControlStoreError("invalid_input", "Structured value is nested too deeply.", { path });
  if (typeof value === "string") {
    const text = value.length > MAX_STRING_SCAN ? value.slice(0, MAX_STRING_SCAN) : value;
    for (const [pattern, what] of VALUE_PATTERNS) if (pattern.test(text)) refuse(path, what);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, checkKeys, state, depth + 1));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (checkKeys && isSecretKey(key)) refuse(childPath, "a member named like a secret");
    walk(child, childPath, checkKeys, state, depth + 1);
  }
}

/** Refuse secret-named members AND secret-shaped values (connection config, bindings). */
export function assertNoSecretKeys(value: unknown, root = ""): void {
  walk(value, root, true, { nodes: 0 }, 0);
}

/** Refuse secret-shaped values only (events, evidence, operation results). */
export function assertNoSecretValues(value: unknown, root = ""): void {
  walk(value, root, false, { nodes: 0 }, 0);
}
