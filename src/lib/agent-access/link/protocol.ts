/**
 * The link protocol's wire rules: what a code looks like, how it is hashed, and
 * how the issued token is held between approval and the first poll.
 *
 * Three secrets pass through this file and none of them is ever stored in the
 * clear or put in a URL:
 *
 *  - the **device code** (`zl_` + 43 base64url chars, 256 bits) is the real
 *    secret of the flow; the exchange is keyed on it. Only its sha256 is
 *    stored, and it never appears in a log line or a query string.
 *  - the **user code** (8 characters, grouped 4-4) is *not* a credential. It
 *    identifies a row to a human, expires in ten minutes and is useless without
 *    a signed-in approval, so `verificationUriComplete` may carry it. Only its
 *    sha256 is stored.
 *  - the **issued token** (`za_` + 43 base64url chars) is minted inside the
 *    approve transaction and sealed here until the poll that consumes it. The
 *    shape is fixed by three independent validators that all pin
 *    `^za_[A-Za-z0-9_-]{43}$` (`security.ts:65`, `http.ts:58`, and
 *    `packages/client/control.ts` in the plugins repo), so nothing about it may
 *    change.
 */
import { createHash, randomBytes } from "node:crypto";
import { AgentError } from "../security";
import { decodeSecretKey, env } from "@/lib/env";
import { seal, secretStoreState, unseal } from "@/lib/secrets";

/**
 * The newest link protocol this server speaks. Version 2 adds the workspace
 * hints on `/start` and the whole-workspace grant (`allProjects` with an empty
 * `projectIds`) on `/token`.
 */
export const LINK_PROTOCOL_VERSION = 2;

/**
 * Every version this server still answers. A version-1 client keeps working
 * unchanged: it is never offered the whole-workspace grant (it would reject the
 * empty `projectIds` at exchange and burn the single-use token), and every
 * response it sees echoes the version it spoke.
 */
export const LINK_PROTOCOL_VERSIONS: readonly number[] = [1, 2];

/** The version a request spoke: absent means 1. Anything else is refused. */
function protocolOf(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !LINK_PROTOCOL_VERSIONS.includes(value))
    throw invalid(
      `This server speaks link protocol versions ${LINK_PROTOCOL_VERSIONS.join(" and ")}. Update the Zenith plugin.`
    );
  return value;
}

/**
 * A workspace name a person would type: 1-60 characters, starting with a letter
 * or digit, then letters, digits, spaces and light punctuation. No control or
 * markup characters, so the unverified hint can only ever fill a text box.
 */
const WORKSPACE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'&()+-]{0,59}$/u;

/** Ten minutes, fixed — §2.1. */
export const LINK_TTL_MS = 600_000;

/** The first poll gap the server asks for, in seconds. */
export const LINK_POLL_INTERVAL_S = 5;

/** The largest gap the server will ever ask for, in seconds. */
export const LINK_POLL_INTERVAL_MAX_S = 30;

/** Failed lookups a single code tolerates before it is retired. */
export const LINK_MAX_FAILED_LOOKUPS = 5;

/** Live linked credentials one subject may hold in one workspace. */
export const LINK_CREDENTIAL_QUOTA = 20;

/** Hard ceiling on a linked credential's lifetime, in days (`security.ts:38`). */
export const LINK_MAX_DAYS = 30;

/**
 * The user-code alphabet: RFC 4648 base32 with `I`, `L`, `O` and `U` removed —
 * 28 symbols. `I`/`L` read as `1`, `O` as `0`, and `U` is dropped because it
 * turns short random strings into words people will not read aloud. 8 symbols
 * over 28 is ~38.5 bits, which §6 checks the abuse controls against.
 */
export const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ234567";

/** How many symbols a user code has. Rendered `XXXX-XXXX`. */
export const USER_CODE_LENGTH = 8;

/* --------------------------------- minting -------------------------------- */

/**
 * One symbol of the alphabet, without modulo bias.
 *
 * 256 is not a multiple of 28, so the top 4 byte values would be over-weighted
 * by a plain `% 28`. Bytes at or above the largest multiple of 28 are drawn
 * again instead.
 */
function symbol(): string {
  const ceiling = 256 - (256 % USER_CODE_ALPHABET.length);
  for (;;) {
    const byte = randomBytes(1)[0];
    if (byte < ceiling) return USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  }
}

/** A fresh user code in its display form, `XXXX-XXXX`. */
export function mintUserCode(): string {
  let code = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) code += symbol();
  return formatUserCode(code);
}

/** A fresh device code. 256 bits, base64url, prefixed so a log grep can find a leak. */
export function mintDeviceCode(): string {
  return `zl_${randomBytes(32).toString("base64url")}`;
}

/**
 * A fresh bearer token, in exactly the shape the three frozen validators pin.
 * `randomBytes(32).toString('base64url')` is 43 characters, always.
 */
export function mintToken(): string {
  return `za_${randomBytes(32).toString("base64url")}`;
}

/* -------------------------------- formatting ------------------------------- */

/** `K7QM3XRB` -> `K7QM-3XRB`. Accepts either form. */
export function formatUserCode(code: string): string {
  const bare = code.replace(/-/g, "");
  return `${bare.slice(0, 4)}-${bare.slice(4)}`;
}

/**
 * What the user typed (or what came out of a query string) reduced to the eight
 * canonical symbols, or `undefined` when it is not a user code at all.
 *
 * Case and the group separator are noise: people retype codes from a terminal
 * into a browser. Nothing else is repaired — mapping `0` to `O` would guess at
 * a code the user did not have, and the answer for a wrong code is the same
 * `link_code_not_found` as for an unknown one anyway.
 */
export function normalizeUserCode(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > 32) return undefined;
  const bare = input.toUpperCase().replace(/[\s-]/g, "");
  if (bare.length !== USER_CODE_LENGTH) return undefined;
  for (const character of bare) if (!USER_CODE_ALPHABET.includes(character)) return undefined;
  return bare;
}

/** Is this the shape `/start` handed out? Checked before any store is touched. */
export function isDeviceCode(value: unknown): value is string {
  return typeof value === "string" && /^zl_[A-Za-z0-9_-]{43}$/.test(value);
}

/* --------------------------------- hashing -------------------------------- */

/** sha256 hex of the canonical (ungrouped, upper-case) user code. */
export function hashUserCode(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

/** sha256 hex of the whole device code, prefix included. */
export function hashDeviceCode(deviceCode: string): string {
  return createHash("sha256").update(deviceCode).digest("hex");
}

/**
 * sha256 hex of the whole bearer token, prefix included — the same digest
 * `authenticate()` computes over `header.slice(7)` (`security.ts:66`), so a
 * credential minted here is one the unmodified validator accepts.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A rate-limit key that is not the thing it identifies.
 *
 * Client addresses are never stored: the salt comes from `ZENITH_SECRET_KEY`,
 * so the bucket key cannot be turned back into an address by anyone reading the
 * table. Without a key configured the link surface is unavailable anyway
 * (`requireLinkSecrets()`), so there is no unsalted path.
 */
export function limitKey(value: string): string {
  // The salt is digested first, so what the value is appended to is exactly 32
  // bytes wide and no address can forge the boundary between the two by
  // containing whatever separator a concatenation would have used.
  const salt = createHash("sha256")
    .update(env().ZENITH_SECRET_KEY ?? "unconfigured")
    .digest();
  return createHash("sha256").update(salt).update(value).digest("hex");
}

/**
 * Who to throttle, for an endpoint with no credential.
 *
 * `x-forwarded-for` is only trusted where the platform overwrites it — Vercel
 * does, and nothing else here may be assumed to. Everywhere else the header is
 * attacker-controlled, so trusting it would let one caller mint a fresh bucket
 * per request. With no trustworthy address the key collapses to one shared
 * bucket, which throttles everybody rather than nobody.
 */
export function clientAddress(request: Request): string {
  if (!process.env.VERCEL) return "shared";
  const forwarded = request.headers.get("x-forwarded-for");
  const left = forwarded?.split(",")[0]?.trim();
  return left && left.length <= 64 ? left : "shared";
}

/* ------------------------------- the seal --------------------------------- */

/**
 * The issued token, encrypted, for the at-most-ten-minutes between approval and
 * the poll that consumes it.
 *
 * AES-256-GCM under `ZENITH_SECRET_KEY` — literally `seal()` from
 * `src/lib/secrets/index.ts`, which owns all of Zenith's secret crypto, with
 * the code's own hash as the second half of the additional authenticated data
 * so a row copied onto another code fails to open rather than handing back the
 * wrong token. The stored bytes are unchanged by the move. Layout is
 * `iv(12) ‖ tag(16) ‖ ciphertext`, one buffer, because the column is one
 * `bytea` and the file store holds one base64 string.
 *
 * With no key configured this throws `link_unavailable` — the link endpoints
 * refuse rather than degrade, which is the rule `secrets/index.ts` already
 * applies to every application secret (ADR D-9).
 */
export function sealLinkSecret(userCodeHash: string, token: string): Buffer {
  requireLinkKey();
  const sealed = seal(LINK_AAD, userCodeHash, token);
  return Buffer.concat([
    Buffer.from(sealed.iv, "base64"),
    Buffer.from(sealed.authTag, "base64"),
    Buffer.from(sealed.ciphertext, "base64"),
  ]);
}

/** The inverse. A sealed value that will not open is a failed exchange, not a token. */
export function openLinkSecret(userCodeHash: string, sealed: Uint8Array): string {
  requireLinkKey();
  const bytes = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (bytes.length < 12 + 16 + 1) throw linkUnavailable();
  try {
    return unseal(LINK_AAD, userCodeHash, {
      iv: bytes.subarray(0, 12).toString("base64"),
      authTag: bytes.subarray(12, 28).toString("base64"),
      ciphertext: bytes.subarray(28).toString("base64"),
    });
  } catch {
    throw new AgentError(
      "link_unavailable",
      "The approved credential cannot be opened with this server's ZENITH_SECRET_KEY. Run `zenith login` again.",
      503
    );
  }
}

/**
 * The first half of the AAD pair. `secrets/index.ts` joins its two labels with
 * a space, so this produces exactly `agent-link <userCodeHash>` — the byte for
 * byte AAD this module has always used, which is what lets the seal move into
 * that file without any stored value changing.
 */
const LINK_AAD = "agent-link";

/**
 * Refuse before sealing, in this module's own words.
 *
 * `seal`/`unseal` throw a store-shaped `Error` when the key is missing or
 * malformed, and a terminal waiting on `zenith login` deserves the link
 * surface's 503 with the variable named instead.
 */
function requireLinkKey(): void {
  const raw = env().ZENITH_SECRET_KEY;
  if (!raw || !decodeSecretKey(raw)) throw linkUnavailable();
}

function linkUnavailable(): AgentError {
  return new AgentError(
    "link_unavailable",
    "Linking an agent needs Zenith's secret key, and this server has none, so there is nowhere safe to hold the issued credential. Fix: set ZENITH_SECRET_KEY and restart the server.",
    503
  );
}

/**
 * The link surface's own configuration gate.
 *
 * Linking is part of agent control, so it follows the same switch: with
 * `ZENITH_AGENT_CONTROL` unset the endpoints answer `503 link_unavailable`,
 * which is exactly what the rollback lever in CONTROL-PLANE §10 promises. The
 * secret key is required for the same reason `sealLinkSecret` needs it.
 */
export function requireLinkSecrets(): void {
  if (process.env.ZENITH_AGENT_CONTROL !== "1")
    throw new AgentError(
      "link_unavailable",
      "Agent linking is not enabled on this server. Fix: set ZENITH_AGENT_CONTROL=1 and redeploy.",
      503
    );
  if (!secretStoreState().configured) throw linkUnavailable();
}

/* ------------------------------ request bodies ----------------------------- */

const objectOf = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const SCOPE_NAMES = ["read", "plan", "export", "write", "publish", "logs"] as const;

/**
 * A bounded JSON body — 4 KiB on `/start`, 1 KiB on `/token`, 16 KiB on
 * `/approve` (§6).
 *
 * This reads the stream itself rather than borrowing `boundedBody` from
 * `control/boundary.ts`, because that module pulls the whole control runtime in
 * behind it and the two unauthenticated link endpoints have no business loading
 * the action catalog to parse 200 bytes of JSON. The limit is enforced on the
 * bytes actually read, not on `content-length`, which a caller chooses.
 */
export async function linkJson(request: Request, maximum: number): Promise<unknown> {
  if ((request.headers.get("content-type") ?? "").split(";")[0].toLowerCase() !== "application/json")
    throw new AgentError("media_type", "Send application/json.", 415);
  const bytes = await boundedLinkBody(request, maximum);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AgentError("invalid_request", "Send bounded UTF-8 JSON.", 400);
  }
}

async function boundedLinkBody(request: Request, maximum: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) throw new AgentError("invalid_request", "Request exceeds its byte limit.", 413);
      chunks.push(item.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const invalid = (message: string): AgentError => new AgentError("invalid_request", message, 400);

export interface StartRequest {
  clientName: string;
  clientVersion?: string;
  label?: string;
  requestedScopes: string[];
  /** The version the client spoke; 1 when it sent none. Echoed on the response. */
  protocolVersion: number;
  /** v2 only: a workspace id to preselect. Unverified; never authority. */
  workspaceHint?: string;
  /** v2 only: a name to prefill "Create a new workspace" with. Unverified. */
  workspaceNameHint?: string;
}

/** §2.1's body, validated exactly as written. Unknown keys are refused. */
export function parseStartRequest(value: unknown): StartRequest {
  if (!objectOf(value)) throw invalid("Send a JSON object describing the client asking for access.");
  const allowed = [
    "clientName",
    "clientVersion",
    "label",
    "requestedScopes",
    "protocolVersion",
    "workspaceHint",
    "workspaceNameHint",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw invalid("This request carries fields this server does not accept.");
  const protocolVersion = protocolOf(value.protocolVersion);
  const workspaceHint = value.workspaceHint;
  const workspaceNameHint = value.workspaceNameHint;
  if ((workspaceHint !== undefined || workspaceNameHint !== undefined) && protocolVersion < 2)
    throw invalid("Workspace hints need link protocol version 2. Send protocolVersion: 2.");
  if (workspaceHint !== undefined && workspaceNameHint !== undefined)
    throw invalid("Send either a workspace to select or a name for a new one, not both.");
  if (workspaceHint !== undefined && !identifier(workspaceHint))
    throw invalid("A workspace hint is a workspace id: 1-100 letters, digits, underscores or dashes.");
  if (
    workspaceNameHint !== undefined &&
    (typeof workspaceNameHint !== "string" ||
      !WORKSPACE_NAME.test(workspaceNameHint) ||
      workspaceNameHint.trim() !== workspaceNameHint)
  )
    throw invalid(
      "A new workspace name is 1-60 plain characters: letters, digits, spaces and . _ ' & ( ) + -, with no leading or trailing space."
    );
  const clientName = value.clientName;
  if (typeof clientName !== "string" || !/^[A-Za-z0-9 ._-]{1,60}$/.test(clientName))
    throw invalid("Supply a client name of 1-60 plain characters.");
  const clientVersion = value.clientVersion;
  if (clientVersion !== undefined && (typeof clientVersion !== "string" || !/^[A-Za-z0-9 ._+-]{1,40}$/.test(clientVersion)))
    throw invalid("A client version is 1-40 plain characters.");
  const label = value.label;
  if (label !== undefined && (typeof label !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(label)))
    throw invalid("A label is 1-40 characters of letters, digits, dot, underscore or dash.");
  const requested = value.requestedScopes;
  if (
    requested !== undefined &&
    (!Array.isArray(requested) ||
      requested.length > 6 ||
      requested.some((scope) => !SCOPE_NAMES.includes(String(scope) as (typeof SCOPE_NAMES)[number])))
  )
    throw invalid("Requested scopes must be drawn from read, plan, export, write, publish and logs.");
  return {
    clientName,
    ...(clientVersion === undefined ? {} : { clientVersion }),
    ...(label === undefined ? {} : { label }),
    // A hint only. The browser decides what is actually granted.
    requestedScopes: [...new Set((requested ?? ["read"]).map(String))],
    protocolVersion,
    ...(workspaceHint === undefined ? {} : { workspaceHint: workspaceHint as string }),
    ...(workspaceNameHint === undefined ? {} : { workspaceNameHint: workspaceNameHint as string }),
  };
}

/** §2.5's body, with the version the poller spoke (1 when absent). */
export function parseTokenBody(value: unknown): { deviceCode: string; protocolVersion: number } {
  if (!objectOf(value)) throw invalid("Send a JSON object carrying the device code.");
  const allowed = ["deviceCode", "protocolVersion"];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw invalid("This request carries fields this server does not accept.");
  const protocolVersion = protocolOf(value.protocolVersion);
  if (!isDeviceCode(value.deviceCode)) throw invalid("Supply the device code this server issued.");
  return { deviceCode: value.deviceCode, protocolVersion };
}

/** §2.5's body: the device code alone. */
export function parseTokenRequest(value: unknown): string {
  return parseTokenBody(value).deviceCode;
}

/**
 * A denial carries nothing but the code, and the type says so: everything the
 * approval path needs is present exactly when `approve` is true, so no handler
 * has to defend against a half-filled approval.
 */
export type ApproveRequest =
  | { approve: false; userCode: string; label?: string }
  | {
      approve: true;
      userCode: string;
      workspaceId: string;
      /** `[]` exactly when `allProjects` is true. */
      projectIds: string[];
      /** Never present with `allProjects`. */
      environmentIds?: string[];
      /** The whole-workspace grant. The authority refuses it for a protocol-1 request. */
      allProjects: boolean;
      scopes: string[];
      days: number;
      label?: string;
    };

const identifier = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(x);

const identifiers = (x: unknown): x is string[] =>
  Array.isArray(x) && x.length > 0 && x.length <= 100 && x.every(identifier) && new Set(x).size === x.length;

/** §2.4's body. Everything in it is rechecked against live state afterwards. */
export function parseApproveRequest(value: unknown): ApproveRequest {
  if (!objectOf(value)) throw invalid("Send a JSON object describing the approval.");
  const allowed = ["userCode", "approve", "workspaceId", "projectIds", "environmentIds", "allProjects", "scopes", "days", "label"];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw invalid("This request carries fields this server does not accept.");
  const userCode = normalizeUserCode(value.userCode);
  if (!userCode) throw invalid("Enter the eight-character code shown in your terminal.");
  if (typeof value.approve !== "boolean") throw invalid("Say explicitly whether this request is approved.");
  const label = value.label;
  if (label !== undefined && (typeof label !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(label)))
    throw invalid("A label is 1-40 characters of letters, digits, dot, underscore or dash.");
  if (!value.approve) return { userCode, approve: false, ...(label === undefined ? {} : { label }) };
  if (!identifier(value.workspaceId)) throw invalid("Choose the workspace this agent may act in.");
  if (value.allProjects !== undefined && typeof value.allProjects !== "boolean")
    throw invalid("Say explicitly whether this agent gets the whole workspace.");
  const allProjects = value.allProjects === true;
  if (allProjects) {
    if (!Array.isArray(value.projectIds) || value.projectIds.length !== 0)
      throw invalid("A whole-workspace grant names no projects: send projectIds: [].");
    if (value.environmentIds !== undefined)
      throw invalid(
        "Environment narrowing needs an explicit project list; it cannot be combined with the whole workspace."
      );
  } else if (!identifiers(value.projectIds)) throw invalid("Choose at least one project this agent may see.");
  if (value.environmentIds !== undefined && !identifiers(value.environmentIds))
    throw invalid("Environment narrowing, when used, is a list of environments of the chosen projects.");
  const scopes = value.scopes;
  if (
    !Array.isArray(scopes) ||
    scopes.length < 1 ||
    scopes.length > 6 ||
    new Set(scopes.map(String)).size !== scopes.length ||
    scopes.some((scope) => !SCOPE_NAMES.includes(String(scope) as (typeof SCOPE_NAMES)[number]))
  )
    throw invalid("Permissions must be drawn from read, plan, export, write, publish and logs.");
  if (!scopes.includes("read")) throw invalid("Read is the minimum any agent needs and cannot be removed.");
  const days = value.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > LINK_MAX_DAYS)
    throw invalid(`Choose a lifetime between 1 and ${LINK_MAX_DAYS} days.`);
  return {
    userCode,
    approve: true,
    workspaceId: value.workspaceId,
    projectIds: value.projectIds as string[],
    ...(value.environmentIds === undefined ? {} : { environmentIds: value.environmentIds as string[] }),
    allProjects,
    scopes: scopes.map(String),
    days,
    ...(label === undefined ? {} : { label }),
  };
}

/** §5's revoke body. */
export function parseRevokeRequest(value: unknown): string {
  if (!objectOf(value) || Object.keys(value).some((key) => key !== "credentialId"))
    throw invalid("Send a JSON object naming the credential to revoke.");
  if (!identifier(value.credentialId)) throw invalid("Name the credential to revoke.");
  return value.credentialId;
}

/**
 * The gap this client is being asked to leave between polls, in seconds.
 *
 * Derived, not stored: `poll_count`, `created_at` and `last_polled_at` are
 * columns the row already has (§3.2, frozen), and how fast a client is polling
 * is exactly `poll_count` against the polls a well-behaved client would have
 * made in the elapsed time. A client that honours the interval never escalates;
 * one that polls three times faster than it was asked to is told 10 seconds,
 * then 20, then 30, which is the cap.
 *
 * The alternative — a stored escalation counter — would have needed a column
 * the frozen DDL does not have, for a value that is a function of two it does.
 */
export function paceInterval(pollCount: number, createdAtMs: number, now: number): number {
  const elapsedS = Math.max(0, now - createdAtMs) / 1000;
  const excess = pollCount - elapsedS / LINK_POLL_INTERVAL_S;
  if (excess <= 0) return LINK_POLL_INTERVAL_S;
  const steps = Math.min(2, Math.floor(excess / 3));
  return Math.min(LINK_POLL_INTERVAL_S * 2 ** (steps + 1), LINK_POLL_INTERVAL_MAX_S);
}
