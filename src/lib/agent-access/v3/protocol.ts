/**
 * MCP protocol version policy for the v3 endpoint (PROD-UX-02).
 *
 * The set is pinned HERE, not inherited from the SDK: upgrading the SDK can
 * never silently widen what Zenith serves (tests/agent-v3/protocol.test.ts
 * proves every pinned version is also one the installed SDK implements).
 *
 *  - 2026-07-28  per-request envelope protocol (stateless; no initialize)
 *  - 2025-11-25, 2025-06-18, 2025-03-26  Streamable HTTP era
 *
 * Explicitly refused: 2024-11-05 and 2024-10-07 (the deprecated HTTP+SSE
 * transport era, no Streamable HTTP) and anything malformed or unknown.
 *
 * Negotiation, per the MCP lifecycle spec:
 *  - `MCP-Protocol-Version` header, when present, must be a supported version
 *    or the request is refused with HTTP 400 and JSON-RPC error -32602 whose
 *    `data` lists what is supported.
 *  - `initialize` with a supported version is answered with that version.
 *    A well-formed date NEWER than every supported version is a counter-offer
 *    case: it passes through and the server answers with the latest version it
 *    supports (the client then decides whether to continue). Everything else
 *    (older unsupported, malformed) is refused, not silently downgraded.
 *  - A 2026-era request envelope naming an unsupported revision is refused.
 */
import { PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";

export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;
export const SUPPORTED_MCP_PROTOCOL_VERSIONS: readonly string[] = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS];
export const REFUSED_MCP_PROTOCOL_VERSIONS: readonly string[] = ["2024-11-05", "2024-10-07"];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const newest = (): string => [...SUPPORTED_MCP_PROTOCOL_VERSIONS].sort().at(-1)!;

export interface VersionRefusal {
  requested: string;
  id: string | number | null;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const rpcId = (message: Json): string | number | null => (typeof message.id === "string" || typeof message.id === "number" ? message.id : null);

function checkMessage(message: unknown): VersionRefusal | undefined {
  if (!isObject(message)) return undefined;
  const params = isObject(message.params) ? message.params : undefined;
  if (message.method === "initialize" && params) {
    const requested = params.protocolVersion;
    if (typeof requested !== "string") return { requested: "(missing)", id: rpcId(message) };
    if (SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requested)) return undefined;
    if (DATE.test(requested) && requested > newest() && !REFUSED_MCP_PROTOCOL_VERSIONS.includes(requested)) return undefined;
    return { requested: requested.slice(0, 40), id: rpcId(message) };
  }
  const meta = params && isObject(params._meta) ? params._meta : undefined;
  const envelope = meta?.[PROTOCOL_VERSION_META_KEY];
  if (envelope !== undefined && (typeof envelope !== "string" || !(MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(envelope))) {
    return { requested: typeof envelope === "string" ? envelope.slice(0, 40) : "(invalid)", id: rpcId(message) };
  }
  return undefined;
}

/**
 * Decide whether this request names a protocol version Zenith serves. `body`
 * is the parsed JSON-RPC body (object, batch array or undefined for GET).
 */
export function checkProtocolVersion(headerVersion: string | null, body: unknown): VersionRefusal | undefined {
  if (headerVersion !== null && !SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(headerVersion.trim())) {
    const first = Array.isArray(body) ? body.find(isObject) : body;
    return { requested: headerVersion.slice(0, 40), id: isObject(first) ? rpcId(first) : null };
  }
  for (const message of Array.isArray(body) ? body : [body]) {
    const refusal = checkMessage(message);
    if (refusal) return refusal;
  }
  return undefined;
}

/** HTTP 400 with the JSON-RPC error the MCP lifecycle spec prescribes for a version mismatch. */
export function versionRefusalResponse(refusal: VersionRefusal): Response {
  return Response.json(
    { jsonrpc: "2.0", id: refusal.id, error: { code: -32602, message: "Unsupported protocol version", data: { requested: refusal.requested, supported: [...SUPPORTED_MCP_PROTOCOL_VERSIONS] } } },
    { status: 400, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }
  );
}
