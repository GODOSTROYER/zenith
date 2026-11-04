/**
 * Verification of agent-signed requests (RUNNER-PROTOCOL.md section 3).
 *
 * Every request after registration carries `X-Zenith-Agent`, `-Timestamp`,
 * `-Nonce`, `-Content-SHA256` and `-Signature`. The signature is Ed25519 over
 * the UTF-8 string (fields joined by `\n`, no trailing newline):
 *
 *     <protocol id>\n<METHOD>\n<path incl. query, as sent>\n<timestamp>\n<nonce>\n<content sha256 hex>
 *
 * Order of checks (cheapest and least revealing first):
 *   1. header shapes                                     401 missing_signature_headers
 *   2. optional `X-Zenith-Protocol` supported            426 upgrade_required
 *   3. agent lookup — unknown OR revoked                 401 agent_revoked (one answer for both:
 *                                                        no oracle, and it is terminal for the agent)
 *   4. the agent's registered protocol is still served   426 upgrade_required
 *   5. body read ONCE as raw bytes, hard-capped, then hashed. The body is never parsed and
 *      re-serialized before hashing: the digest covers the bytes that arrived.
 *   6. clock skew <= 60 s                                401 clock_skew
 *   7. body digest equals the header                     401 body_digest_mismatch
 *   8. Ed25519 signature over the signing string         401 invalid_signature
 *   9. nonce unseen within 10 minutes (atomic, AFTER the signature so an
 *      unauthenticated caller cannot burn an agent's nonces)   401 nonce_replayed
 *
 * The caller then compares the authenticated agent's id with the id in the URL
 * (`assertPathAgent`): a valid signature by runner A is not authority over
 * runner B's queue.
 *
 * Path: the signed path is `pathname + search` of `request.url` exactly as the
 * server received it (the Go client signs `req.URL.RequestURI()`). A reverse
 * proxy that rewrites the path or query would break signatures; it must not.
 */
import { createHash } from "node:crypto";
import { verifyEd25519 } from "@/lib/runners/signing";
import { upgradeRequiredError } from "@/lib/runners/protocol-window";
import { registryOf, type AgentRecord, type RunnerStore } from "@/lib/runners/ports";
import {
  AGENT_KINDS,
  AgentApiError,
  HEADER_AGENT,
  HEADER_CONTENT_SHA256,
  HEADER_NONCE,
  HEADER_PROTOCOL,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  MAX_SMALL_BODY_BYTES,
  NONCE_WINDOW_MS,
  SKEW_SEC,
  isValidId,
  type AgentKind,
} from "@/lib/runners/types";

/** The signing string of spec section 3. Exported so clients and tests build it the same way. */
export function signingString(protocol: string, method: string, pathAndQuery: string, timestamp: number | string, nonce: string, contentSha256: string): string {
  return [protocol, method.toUpperCase(), pathAndQuery, String(timestamp), nonce, contentSha256].join("\n");
}

export const sha256HexOfBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface AgentAuthDeps {
  store: RunnerStore;
  /** epoch milliseconds */
  now: () => number;
}

export interface VerifiedAgentRequest {
  agent: AgentRecord;
  /** the raw body bytes that were hashed (empty for no body) */
  body: Uint8Array;
  pathAndQuery: string;
  timestamp: number;
  nonce: string;
}

const SHA_HEX = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const TIMESTAMP = /^[0-9]{1,12}$/;

/**
 * Read a request body once, as raw bytes, refusing more than `max` bytes
 * (by `content-length` up front and by counting while streaming).
 */
export async function readBodyBytes(req: Request, max: number): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > max) throw tooLarge(max);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(max);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const tooLarge = (max: number): AgentApiError => new AgentApiError(413, "payload_too_large", `The request body is larger than ${max} bytes.`, { maxBytes: max });

const revoked = (): AgentApiError => new AgentApiError(401, "agent_revoked", "This agent is unknown or has been revoked; stop and re-register with a new token.");

export function pathAndQueryOf(req: Request): string {
  const u = new URL(req.url);
  return u.pathname + u.search;
}

/** Verify one agent-signed request and return the authenticated agent and the raw body. */
export async function authenticateAgentRequest(
  req: Request,
  kind: AgentKind,
  deps: AgentAuthDeps,
  opts: { maxBodyBytes?: number } = {}
): Promise<VerifiedAgentRequest> {
  const h = req.headers;
  const agentId = h.get(HEADER_AGENT);
  const timestampRaw = h.get(HEADER_TIMESTAMP);
  const nonce = h.get(HEADER_NONCE);
  const contentSha = h.get(HEADER_CONTENT_SHA256);
  const signatureB64 = h.get(HEADER_SIGNATURE);
  if (!isValidId(agentId) || !timestampRaw || !TIMESTAMP.test(timestampRaw) || !nonce || !NONCE.test(nonce) || !contentSha || !SHA_HEX.test(contentSha) || !signatureB64 || !SIGNATURE.test(signatureB64))
    throw new AgentApiError(401, "missing_signature_headers", "Every request needs well-formed X-Zenith-Agent, -Timestamp, -Nonce, -Content-SHA256 and -Signature headers.");

  const info = AGENT_KINDS[kind];
  const declared = h.get(HEADER_PROTOCOL);
  if (declared !== null && !info.protocols.includes(declared)) throw upgradeRequiredError(kind);

  const agent = await registryOf(deps.store, kind).findForAuth(agentId);
  if (!agent || agent.status !== "active") throw revoked();
  if (!info.protocols.includes(agent.protocol)) throw upgradeRequiredError(kind);

  const body = await readBodyBytes(req, opts.maxBodyBytes ?? MAX_SMALL_BODY_BYTES);

  const timestamp = Number(timestampRaw);
  if (Math.abs(Math.floor(deps.now() / 1000) - timestamp) > SKEW_SEC) throw new AgentApiError(401, "clock_skew", `The request timestamp is more than ${SKEW_SEC} seconds from the control plane's clock.`);

  if (sha256HexOfBytes(body) !== contentSha) throw new AgentApiError(401, "body_digest_mismatch", "X-Zenith-Content-SHA256 does not match the request body.");

  const pathAndQuery = pathAndQueryOf(req);
  const signed = Buffer.from(signingString(agent.protocol, req.method, pathAndQuery, timestampRaw, nonce, contentSha), "utf8");
  if (!verifyEd25519(agent.publicKey, signed, Buffer.from(signatureB64, "base64url"))) throw new AgentApiError(401, "invalid_signature", "The request signature does not verify against the registered key.");

  if (!(await deps.store.nonces.remember(agent.id, nonce, NONCE_WINDOW_MS))) throw new AgentApiError(401, "nonce_replayed", "This nonce was already used.");

  return { agent, body, pathAndQuery, timestamp, nonce };
}

/** A valid signature by agent A is no authority over agent B: the URL's agent must be the signer. */
export function assertPathAgent(agent: AgentRecord, pathId: string): void {
  if (agent.id !== pathId) throw new AgentApiError(403, "agent_mismatch", "The signing agent is not the agent this URL addresses.");
}

/** Parse a verified body as a JSON object; empty is `{}`. */
export function parseJsonBody(body: Uint8Array): unknown {
  if (body.byteLength === 0) return {};
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new AgentApiError(400, "invalid_request", "The request body is not valid JSON.");
  }
}
