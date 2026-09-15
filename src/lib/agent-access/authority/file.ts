/**
 * The file credential authority — the single-host mode, unchanged where it
 * matters.
 *
 * `verify()` is `authenticate(header, await loadCredentials(path))` and nothing
 * else: the authorization path keeps exactly the behaviour, the refusals and
 * the POSIX demands it has today (`security.ts:45-72`). What is new is the
 * writing half, which mints the same version-1 JSON record
 * `scripts/agent-credential.mjs` writes, through the same discipline — a `mkdir`
 * lock directory, a temp file at 0600, `fsync`, atomic `rename` — so `zenith
 * login` against a local `next dev` and the operator utility can be used on one
 * authority file without either corrupting the other's writes.
 *
 * Link codes live in a sibling `link-codes.json` in the same private directory
 * and under the same lock, so an approval that mints a credential and consumes
 * a code cannot half-happen.
 *
 * **Windows is refused, deliberately.** `loadCredentials` names the platform
 * outright (`security.ts:51`) because this authority's whole security argument
 * is POSIX ownership and mode bits, which Windows does not have. `ready()`
 * refuses there, the link endpoints answer 503, and the plugin tells the user
 * to use the operator utility instead (LINK-PROTOCOL §7).
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  AgentError,
  authenticate,
  loadCredentials,
  parseCredentials,
  type Credential,
} from "../security";
import {
  LINK_CREDENTIAL_QUOTA,
  LINK_MAX_DAYS,
  LINK_MAX_FAILED_LOOKUPS,
  hashToken,
  mintToken,
  openLinkSecret,
  paceInterval,
  sealLinkSecret,
} from "../link/protocol";
import type {
  ApproveLinkInput,
  CredentialAuthority,
  ExchangeResult,
  LinkRow,
  LinkStart,
  LinkedCredential,
} from "./types";

/** What `parseCredentials` refuses to exceed (`security.ts:23`). */
const MAX_CREDENTIALS = 100;

/** Link codes kept at once. Bounded for the same reason the credential file is. */
const MAX_LINK_CODES = 200;

/** How long a consumed or expired code is kept before the next write drops it. */
const LINK_RETENTION_MS = 86_400_000;

interface StoredLink {
  userCodeHash: string;
  deviceCodeHash: string;
  state: LinkRow["state"];
  clientName: string;
  clientVersion?: string;
  label?: string;
  requestedScopes: string[];
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  approvedBy?: string;
  credentialId?: string;
  /** the issued token, sealed; base64 of `iv ‖ tag ‖ ciphertext` */
  secretCt?: string;
  pollCount: number;
  lastPolledAt?: string;
  failedLookups: number;
}

interface LinkFile {
  version: 1;
  codes: StoredLink[];
}

const unavailable = (message: string): AgentError =>
  new AgentError("policy_unavailable", message, 503);

function credentialFile(): string {
  const path = process.env.ZENITH_AGENT_CREDENTIAL_FILE ?? "";
  if (!isAbsolute(path))
    throw unavailable(
      "This server has no agent credential authority. Fix: set ZENITH_AGENT_CREDENTIAL_FILE to an absolute path inside a private 0700 directory."
    );
  return path;
}

const linkFile = (path: string): string => join(dirname(path), "link-codes.json");

const posix = (): boolean => process.platform !== "win32";

/* ------------------------------ the lock ----------------------------------- */

/**
 * The operator utility's lock, taken the same way: a directory, created
 * exclusively, removed in `finally`. `mkdir` is the only filesystem primitive
 * that is atomic on every platform Zenith runs on, which is why both writers
 * use it rather than an advisory lock nothing else would honour.
 */
async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      try {
        return await fn();
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw unavailable(
    "The agent credential file is locked by another writer. Fix: wait for the other operation to finish, or remove a stale .lock directory only when no operator is using it."
  );
}

/** Write bytes where `rename` makes them appear whole or not at all. */
async function writeAtomic(path: string, contents: string): Promise<void> {
  if (Buffer.byteLength(contents) > 65536)
    throw unavailable(
      "The agent authority file would exceed 64 KiB. Fix: revoke unused credentials on the Integrations screen."
    );
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/* --------------------------- credential records ---------------------------- */

async function readCredentials(path: string): Promise<Credential[]> {
  try {
    const raw = await readFile(path, "utf8");
    return parseCredentials(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    if (error instanceof AgentError) throw error;
    throw unavailable("The operator must repair the version-1 credential file.");
  }
}

const writeCredentials = (path: string, credentials: Credential[]): Promise<void> =>
  writeAtomic(path, `${JSON.stringify({ version: 1, credentials }, null, 2)}\n`);

/* ------------------------------- link records ------------------------------ */

async function readLinks(path: string): Promise<LinkFile> {
  try {
    const raw = JSON.parse(await readFile(linkFile(path), "utf8")) as LinkFile;
    if (raw?.version !== 1 || !Array.isArray(raw.codes))
      throw unavailable("The link-code file is not a version-1 record. Fix: delete link-codes.json and link again.");
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, codes: [] };
    if (error instanceof AgentError) throw error;
    throw unavailable("The link-code file could not be read. Fix: delete link-codes.json and link again.");
  }
}

/** Housekeeping every write does: drop long-dead rows, then bound the rest. */
function prune(codes: StoredLink[], now: number): StoredLink[] {
  const live = codes.filter((code) => Date.parse(code.expiresAt) > now - LINK_RETENTION_MS);
  return live.slice(Math.max(0, live.length - MAX_LINK_CODES));
}

const writeLinks = (path: string, file: LinkFile): Promise<void> =>
  writeAtomic(linkFile(path), `${JSON.stringify(file, null, 2)}\n`);

/** Expiry is a fact about the clock, not a state anybody has to write first. */
function effectiveState(code: StoredLink, now: number): LinkRow["state"] {
  if (code.state === "pending" || code.state === "approved")
    return Date.parse(code.expiresAt) <= now ? "expired" : code.state;
  return code.state;
}

const view = (code: StoredLink, now: number): LinkRow => ({
  // The store holds only the hash; the caller echoes the code it looked up with.
  userCode: "",
  state: effectiveState(code, now),
  clientName: code.clientName,
  ...(code.clientVersion === undefined ? {} : { clientVersion: code.clientVersion }),
  ...(code.label === undefined ? {} : { label: code.label }),
  requestedScopes: code.requestedScopes,
  createdAt: code.createdAt,
  expiresAt: code.expiresAt,
  ...(code.credentialId === undefined ? {} : { credentialId: code.credentialId }),
});

/* -------------------------------- authority -------------------------------- */

class FileCredentialAuthority implements CredentialAuthority {
  readonly kind = "file" as const;

  async ready(): Promise<void> {
    const path = credentialFile();
    if (!posix())
      throw unavailable(
        "The file credential authority needs POSIX ownership and permission bits, which Windows does not have, so an agent cannot be linked on this host. Fix: run Zenith on Linux or macOS, or point ZENITH_STORE at Postgres."
      );
    const directory = await lstat(dirname(path)).catch(() => undefined);
    if (
      !directory ||
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid!() ||
      (directory.mode & 0o077) !== 0
    )
      throw unavailable(
        "The agent credential file must live in a directory this server owns and nobody else can read. Fix: `mkdir -m 700` the directory named by ZENITH_AGENT_CREDENTIAL_FILE and `chown` it to the server's user."
      );
  }

  async verify(authorizationHeader: string | null, now = Date.now()): Promise<Credential> {
    return authenticate(authorizationHeader, await loadCredentials(credentialFile()), now);
  }

  async touch(): Promise<void> {
    // Deliberately nothing. `parseCredentials`'s key allowlist has no
    // `lastUsedAt`, and a per-request rewrite of the authority file would
    // contend with the operator utility's lock for a diagnostic. The Postgres
    // authority, whose row has the column, is where last use is recorded.
  }

  async startLink(start: LinkStart): Promise<void> {
    const path = credentialFile();
    const now = Date.now();
    await withLock(path, async () => {
      const file = await readLinks(path);
      const codes = prune(file.codes, now);
      if (codes.some((code) => code.userCodeHash === start.userCodeHash || code.deviceCodeHash === start.deviceCodeHash))
        throw new AgentError("rate_limited", "Try linking again.", 429);
      codes.push({ ...start, state: "pending", pollCount: 0, failedLookups: 0 });
      await writeLinks(path, { version: 1, codes });
    });
  }

  async linkByUserCode(userCodeHash: string, now = Date.now()): Promise<LinkRow | undefined> {
    const path = credentialFile();
    return withLock(path, async () => {
      const file = await readLinks(path);
      const code = file.codes.find((candidate) => candidate.userCodeHash === userCodeHash);
      if (!code) return undefined;
      if (effectiveState(code, now) !== "pending") return view(code, now);
      // A code that keeps being looked up and not approved is being guessed at.
      // The counter has to survive the call, so this lookup is a write — which
      // is also why it is bounded and under the same lock as everything else.
      code.failedLookups += 1;
      if (code.failedLookups > LINK_MAX_FAILED_LOOKUPS) {
        code.state = "expired";
        code.secretCt = undefined;
      }
      await writeLinks(path, file);
      return view(code, now);
    });
  }

  async approveLink(input: ApproveLinkInput): Promise<{ credentialId: string; expiresAt: string }> {
    const path = credentialFile();
    const now = input.now ?? Date.now();
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > LINK_MAX_DAYS)
      throw new AgentError("invalid_request", `Choose a lifetime between 1 and ${LINK_MAX_DAYS} days.`, 400);
    return withLock(path, async () => {
      const file = await readLinks(path);
      const code = file.codes.find((candidate) => candidate.userCodeHash === input.userCodeHash);
      if (!code || effectiveState(code, now) === "expired")
        throw new AgentError("link_code_not_found", "This link request is no longer waiting. Run `zenith login` again.", 404);
      if (code.state !== "pending")
        throw new AgentError("link_code_consumed", "This link request was already answered.", 409);

      const credentials = await readCredentials(path);
      const live = credentials.filter(
        (credential) =>
          credential.subject === input.subject &&
          credential.workspaceId === input.workspaceId &&
          !credential.revokedAt &&
          Date.parse(credential.expiresAt) > now
      );
      if (live.length >= LINK_CREDENTIAL_QUOTA)
        throw new AgentError(
          "credential_quota",
          `This account already has ${LINK_CREDENTIAL_QUOTA} linked agents in this workspace. Revoke one under Integrations → Linked agents and link again.`,
          429
        );
      if (credentials.length >= MAX_CREDENTIALS)
        throw new AgentError(
          "credential_quota",
          `The credential authority file holds ${MAX_CREDENTIALS} records, which is its limit. Revoke unused agents under Integrations → Linked agents.`,
          429
        );

      const token = mintToken();
      const credentialId = `cred_${randomUUID()}`;
      const credential: Credential = {
        id: credentialId,
        tokenHash: hashToken(token),
        subject: input.subject,
        workspaceId: input.workspaceId,
        projectIds: [...new Set(input.projectIds)],
        ...(input.environmentIds ? { environmentIds: [...new Set(input.environmentIds)] } : {}),
        scopes: [...new Set(input.scopes)] as Credential["scopes"],
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + input.days * 86_400_000).toISOString(),
        ...(input.label ?? code.label ? { label: input.label ?? code.label } : {}),
        clientName: code.clientName,
      };
      // Parsed before it is written, so a record this build would refuse to
      // load is never the one it just issued.
      parseCredentials({ version: 1, credentials: [...credentials, credential] });

      // Seal first: a failure here must leave the code pending, not leave a
      // credential nobody can reach.
      const secretCt = sealLinkSecret(input.userCodeHash, token).toString("base64");
      code.state = "approved";
      code.approvedAt = new Date(now).toISOString();
      code.approvedBy = input.subject;
      code.credentialId = credentialId;
      code.secretCt = secretCt;

      await writeCredentials(path, [...credentials, credential]);
      try {
        await writeLinks(path, { version: 1, codes: prune(file.codes, now) });
      } catch (error) {
        // The credential exists but the code does not name it, so nothing can
        // exchange for it. Withdraw it rather than leave a live secret nobody
        // asked for.
        await writeCredentials(path, credentials).catch(() => {});
        throw error;
      }
      return { credentialId, expiresAt: credential.expiresAt };
    });
  }

  async denyLink(userCodeHash: string, subject: string): Promise<boolean> {
    const path = credentialFile();
    const now = Date.now();
    return withLock(path, async () => {
      const file = await readLinks(path);
      const code = file.codes.find((candidate) => candidate.userCodeHash === userCodeHash);
      if (!code || code.state !== "pending" || effectiveState(code, now) === "expired") return false;
      code.state = "denied";
      code.approvedAt = new Date(now).toISOString();
      code.approvedBy = subject;
      code.secretCt = undefined;
      await writeLinks(path, file);
      return true;
    });
  }

  async exchange(deviceCodeHash: string, now = Date.now()): Promise<ExchangeResult> {
    const path = credentialFile();
    return withLock(path, async () => {
      const file = await readLinks(path);
      const code = file.codes.find((candidate) => candidate.deviceCodeHash === deviceCodeHash);
      if (!code) return { status: "unknown" };
      const state = effectiveState(code, now);
      if (state === "expired" || state === "consumed") return { status: "expired" };
      if (state === "denied") return { status: "denied" };

      const since = code.lastPolledAt ? now - Date.parse(code.lastPolledAt) : Number.POSITIVE_INFINITY;
      const paced = paceInterval(code.pollCount, Date.parse(code.createdAt), now);
      const early = since < paced * 1000;
      code.pollCount += 1;
      code.lastPolledAt = new Date(now).toISOString();

      if (state === "pending") {
        await writeLinks(path, file);
        return early
          ? { status: "slow_down", interval: paced }
          : { status: "authorization_pending", interval: paced };
      }

      // Approved. One exchange, and the secret is destroyed by the same write
      // that consumes the row.
      const sealed = code.secretCt;
      if (!sealed) return { status: "expired" };
      const token = openLinkSecret(code.userCodeHash, Buffer.from(sealed, "base64"));
      code.state = "consumed";
      code.secretCt = undefined;
      await writeLinks(path, { version: 1, codes: prune(file.codes, now) });

      const credential = (await readCredentials(path)).find(
        (candidate) => candidate.id === code.credentialId
      );
      // The credential was revoked between approval and this poll, or the file
      // was repaired underneath us. There is nothing to hand over.
      if (!credential || credential.revokedAt) return { status: "expired" };
      return { status: "issued", credential, token };
    });
  }

  async listCredentials(subject: string, workspaceId: string): Promise<LinkedCredential[]> {
    const credentials = await readCredentials(credentialFile());
    return credentials
      .filter(
        (credential) =>
          credential.subject === subject &&
          credential.workspaceId === workspaceId &&
          credential.clientName !== undefined
      )
      .map((credential) => ({ ...credential, tokenHash: "" }));
  }

  async revokeCredential(
    subject: string | null,
    workspaceId: string,
    credentialId: string
  ): Promise<boolean> {
    const path = credentialFile();
    return withLock(path, async () => {
      const credentials = await readCredentials(path);
      const found = credentials.find(
        (credential) =>
          credential.id === credentialId &&
          credential.workspaceId === workspaceId &&
          (subject === null || credential.subject === subject) &&
          !credential.revokedAt
      );
      if (!found) return false;
      found.revokedAt = new Date().toISOString();
      await writeCredentials(path, credentials);
      return true;
    });
  }

  async expireLinks(now = Date.now()): Promise<number> {
    const path = credentialFile();
    return withLock(path, async () => {
      const file = await readLinks(path);
      let moved = 0;
      for (const code of file.codes)
        if ((code.state === "pending" || code.state === "approved") && Date.parse(code.expiresAt) <= now) {
          code.state = "expired";
          code.secretCt = undefined;
          moved += 1;
        }
      const codes = prune(file.codes, now);
      if (moved || codes.length !== file.codes.length) await writeLinks(path, { version: 1, codes });
      return moved;
    });
  }
}

type AuthorityGlobal = typeof globalThis & { __zenithFileCredentialAuthority?: FileCredentialAuthority };

/** One instance per process, for the same reason every other store is. */
export function fileCredentialAuthority(): CredentialAuthority {
  const global = globalThis as AuthorityGlobal;
  return (global.__zenithFileCredentialAuthority ??= new FileCredentialAuthority());
}

/**
 * The link surface's rate limiter on this store.
 *
 * `DurableRateLimiter` already keys `(workspace, subject, bucket)`, already
 * bounds its own size and already deletes stale buckets on every check; the
 * link surface needs `(scope, key, bucket)`, which is the same two columns
 * under different names. Passing the scope as the workspace and the salted key
 * as the subject reuses the durable table exactly as it stands, rather than
 * adding a second limiter with its own idea of a window. Nothing in
 * `rate-limit.ts` is modified.
 */
export async function fileRateLimit(
  scope: string,
  key: string,
  options: { limit: number; windowMs: number }
): Promise<void> {
  const { DurableRateLimiter } = await import("../control/rate-limit");
  const { claimDataDir } = await import("@/lib/data-lock");
  const { env } = await import("@/lib/env");
  const { resolve } = await import("node:path");
  const global = globalThis as LimiterGlobal;
  if (!global.__zenithAgentLinkLimiter) {
    const data = env().ZENITH_DATA;
    claimDataDir(data);
    global.__zenithAgentLinkLimiter = new DurableRateLimiter(
      resolve(data, "agent-control", "rate-limits.sqlite")
    );
  }
  global.__zenithAgentLinkLimiter.check(
    { subject: key, integrationId: "link", workspaceId: scope, projectIds: [], scopes: [], expiresAt: "" },
    options
  );
}

type LimiterGlobal = typeof globalThis & {
  __zenithAgentLinkLimiter?: import("../control/rate-limit").DurableRateLimiter;
};
