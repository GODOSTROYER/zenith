/** Raw-body authentication precedes JSON authority, control SQL and revocation. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import type { Sql } from "@/lib/controlplane/types";
import { GithubSourceError, numericId } from "./types";

export const GITHUB_WEBHOOK_MAX_BYTES = 1024 * 1024;
const DEADLINE_MS = 8_000;
const verified: unique symbol = Symbol("verified GitHub revocation");
const authenticated = new WeakSet<object>();
export interface VerifiedGithubRevocation {
  readonly [verified]: true;
  readonly appId: string;
  readonly deliveryId: string;
  readonly bodySha256: string;
  readonly event: "installation" | "installation_repositories";
  readonly action: "deleted" | "suspend" | "removed";
  readonly installationId: number;
  readonly repositoryIds: readonly number[];
}
/** A nominal TypeScript cast cannot acquire this private runtime capability. */
export function isVerifiedGithubRevocation(value: unknown): value is VerifiedGithubRevocation {
  return typeof value === "object" && value !== null && authenticated.has(value);
}
class WebhookFailure extends Error {
  constructor(readonly status: number) { super("GitHub webhook refused."); }
}
function invalid(): never { throw new WebhookFailure(400); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): number {
  try { return numericId(value); } catch { return invalid(); }
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode
    && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Canonical, private POSIX file; no symlinks, hardlinks, public parent or trim. */
async function webhookSecret(file: string): Promise<Buffer> {
  let handle;
  const bytes = Buffer.alloc(4097);
  try {
    const uid = process.getuid?.();
    if (uid === undefined || constants.O_NOFOLLOW === undefined || !isAbsolute(file) || normalize(file) !== file
      || await realpath(file) !== file) throw new Error("custody unavailable");
    const parent = dirname(file); const directory = await lstat(parent);
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o7777) !== 0o700) throw new Error("private parent required");
    for (let p = parent; ; p = dirname(p)) {
      const s = await lstat(p);
      const trustedSticky = s.uid === 0 && (s.mode & 0o1000) !== 0;
      if (!s.isDirectory() || ![0, uid].includes(s.uid) || ((s.mode & 0o022) !== 0 && !trustedSticky)) throw new Error("unsafe ancestor");
      if (p === dirname(p)) break;
    }
    const before = await lstat(file);
    if (!before.isFile() || before.uid !== uid || before.nlink !== 1 || ![0o400, 0o600].includes(before.mode & 0o7777)
      || before.size < 32 || before.size > 4096) throw new Error("unsafe secret");
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!sameFile(before, await handle.stat())) throw new Error("secret changed");
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== before.size || !sameFile(before, await handle.stat()) || !sameFile(before, await lstat(file))
      || !sameFile(directory, await lstat(parent)) || await realpath(file) !== file
      || bytes.subarray(0, bytesRead).some(c => c < 33 || c > 126)) throw new Error("secret changed or invalid");
    return bytes.subarray(0, bytesRead);
  } catch {
    bytes.fill(0); throw new WebhookFailure(503);
  } finally { await handle?.close().catch(() => undefined); }
}

async function rawBody(req: Request): Promise<Buffer> {
  const length = req.headers.get("content-length");
  if (length !== null && !/^(0|[1-9]\d{0,7})$/.test(length)) return invalid();
  if (length !== null && Number(length) > GITHUB_WEBHOOK_MAX_BYTES) throw new WebhookFailure(413);
  if (!req.body) return invalid();
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(DEADLINE_MS)]);
  const reader = req.body.getReader(); const chunks: Buffer[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(new WebhookFailure(408)); };
        signal.addEventListener("abort", abort, { once: true });
        reader.read().then(value => { signal.removeEventListener("abort", abort); resolve(value); }, () => { signal.removeEventListener("abort", abort); reject(new WebhookFailure(400)); });
        if (signal.aborted) abort();
      });
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > GITHUB_WEBHOOK_MAX_BYTES) throw new WebhookFailure(413);
      chunks.push(Buffer.from(chunk.value));
    }
    if (length !== null && Number(length) !== size) return invalid();
    return Buffer.concat(chunks, size);
  } finally {
    chunks.forEach(chunk => chunk.fill(0));
    void reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}

/** JSON.parse validates grammar; this walk rejects duplicate/escaped key aliases. */
function payload(bytes: Buffer): Record<string, unknown> {
  let text: string; let parsed: unknown;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); parsed = JSON.parse(text); } catch { return invalid(); }
  let i = 0; let values = 0;
  const space = () => { while (/[ \t\r\n]/.test(text[i] ?? "x")) i++; };
  const string = (): string => {
    const start = i++;
    while (text[i] !== '"') { if (text[i] === "\\") i++; i++; }
    return JSON.parse(text.slice(start, ++i)) as string;
  };
  const visit = (depth: number): void => {
    if (depth > 64 || ++values > 100_000) return invalid();
    space();
    if (text[i] === "{") {
      i++; space(); const keys = new Set<string>();
      if (text[i] !== "}") for (;;) {
        space(); const key = string(); if (keys.has(key)) return invalid(); keys.add(key);
        space(); i++; visit(depth + 1); space();
        if (text[i] !== ",") break;
        i++;
      }
      i++;
    } else if (text[i] === "[") {
      i++; space();
      if (text[i] !== "]") for (;;) { visit(depth + 1); space(); if (text[i] !== ",") break; i++; }
      i++;
    } else if (text[i] === '"') string();
    else while (i < text.length && !/[,\]} \t\r\n]/.test(text[i])) i++;
  };
  visit(0);
  return object(parsed);
}

/** Only authenticated immutable IDs become SQL authority; provider URLs are inert. */
export async function authenticateGithubWebhook(req: Request, env: Readonly<Record<string, string | undefined>> = process.env): Promise<VerifiedGithubRevocation | undefined> {
  const appId = env.ZENITH_GITHUB_APP_ID; const file = env.ZENITH_GITHUB_APP_WEBHOOK_SECRET_FILE;
  if (!appId || !/^[1-9]\d{0,15}$/.test(appId) || !Number.isSafeInteger(Number(appId)) || !file) throw new WebhookFailure(503);
  const deliveryId = req.headers.get("x-github-delivery")?.toLowerCase();
  const event = req.headers.get("x-github-event"); const signature = req.headers.get("x-hub-signature-256");
  if (req.method !== "POST" || new URL(req.url).search || !deliveryId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(deliveryId)
    || !event || !["installation", "installation_repositories", "ping"].includes(event)
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers.get("content-type") ?? "")
    || ![null, "identity"].includes(req.headers.get("content-encoding"))) return invalid();
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) throw new WebhookFailure(403);
  let secret: Buffer | undefined; let body: Buffer | undefined;
  try {
    secret = await webhookSecret(file); body = await rawBody(req);
    const expected = createHmac("sha256", secret).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"))) throw new WebhookFailure(403);
    const data = payload(body);
    if (event === "ping") return;
    const installation = object(data.installation); const installationId = id(installation.id);
    if (String(id(installation.app_id)) !== appId) throw new WebhookFailure(403);
    id(object(data.sender).id);
    const action = data.action;
    if (event === "installation" && ["created", "unsuspend", "new_permissions_accepted"].includes(String(action))) return;
    if (event === "installation_repositories" && action === "added") return;
    if (!(event === "installation" && ["deleted", "suspend"].includes(String(action)))
      && !(event === "installation_repositories" && action === "removed")) return invalid();
    const repositoryIds: number[] = [];
    if (action === "suspend") {
      if (typeof installation.suspended_at !== "string" || !Number.isFinite(Date.parse(installation.suspended_at))) return invalid();
      id(object(installation.suspended_by).id);
    }
    if (event === "installation_repositories") {
      if (!Array.isArray(data.repositories_removed) || data.repositories_removed.length < 1 || data.repositories_removed.length > 1000
        || !Array.isArray(data.repositories_added) || data.repositories_added.length !== 0
        || !["all", "selected"].includes(String(data.repository_selection))) return invalid();
      for (const row of data.repositories_removed) repositoryIds.push(id(object(row).id));
      if (new Set(repositoryIds).size !== repositoryIds.length) return invalid();
      repositoryIds.sort((a, b) => a - b);
    }
    const accepted = Object.freeze({ [verified]: true as const, appId, deliveryId, bodySha256: createHash("sha256").update(body).digest("hex"),
      event: event as VerifiedGithubRevocation["event"], action: action as VerifiedGithubRevocation["action"], installationId, repositoryIds: Object.freeze(repositoryIds) });
    authenticated.add(accepted);
    return accepted;
  } finally { secret?.fill(0); body?.fill(0); }
}

/** Standalone webhook transport: browser admission and boot never precede HMAC. */
export function createGithubWebhookHandler(deps: { db: () => Promise<Sql>; env?: Readonly<Record<string, string | undefined>> }) {
  return async (req: Request): Promise<Response> => {
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    try {
      const event = await authenticateGithubWebhook(req, deps.env);
      if (event) {
        const { createGithubWebhookStore } = await import("./webhook-store");
        await createGithubWebhookStore(await deps.db()).apply(event);
      }
      return new Response(null, { status: 204, headers });
    } catch (error) {
      const status = error instanceof WebhookFailure ? error.status : error instanceof GithubSourceError
        ? { invalid: 400, refused: 403, conflict: 409, unavailable: 503 }[error.code] : 503;
      return Response.json({ error: { message: "GitHub webhook could not be accepted." } }, { status, headers });
    }
  };
}
