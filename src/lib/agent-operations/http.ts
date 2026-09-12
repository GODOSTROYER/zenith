/** Maintained MCP SDK transport. Identity and authority remain in Zenith. */
import { createMcpHandler, McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { configuration, metadata, validateOrigin } from "./config";
import { authenticateOAuth, authenticateOpaque, boundedBytes, loadGrants, operatorKey, select, verifyReview, object, type AgentGrant, type ReviewRequest } from "./access";
import { OperationError } from "./journal";
import { inApplication, journal, liveMember, publicReceipt, writeAvailability } from "./application";
import { callTool, operationTools } from "./tools";
import { redact } from "@/lib/agent-access/security";
import { acceptUpload, permittedApp, authorizeAppReview } from "./hosted";
import { MAX_UPLOAD_BYTES } from "./uploads";
import { authority } from "@/lib/hosted/authority";
import { ensureBoot } from "@/lib/server/boot";
import { requireScope } from "./access";

const MAX_BODY = 131072, MAX_RESULT = 262144;
const buckets = new Map<string, { at: number; count: number }>();
function response(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(value === undefined ? null : JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra } });
}
function failure(error: unknown, requestId: string): Response {
  const e = error instanceof OperationError ? error : new OperationError("operation_unavailable", "The operation could not complete. Inspect server diagnostics using the request ID; do not retry an uncertain write with a new key.", 503);
  let challenge: Record<string, string> = {};
  try {
    const config = configuration();
    if (e.status === 401 && config.mode === "oauth") challenge = { "www-authenticate": `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/api/agent/v2/mcp"` };
  } catch { /* configuration errors reveal no provider secrets */ }
  return response({ error: { code: e.code, message: e.message }, requestId }, e.status, { "x-request-id": requestId, ...challenge });
}
export async function authenticateRequest(request: Request): Promise<{ grant: AgentGrant; selected: ReturnType<typeof select> }> {
  const config = configuration();
  if (!config.enabled) throw new OperationError("agent_disabled", "Enable the reviewed agent service explicitly before connecting. Legacy v1 access is configured separately.", 503);
  validateOrigin(request, config.origin);
  const grants = await loadGrants(config.grantsPath);
  const grant = config.mode === "oauth" ? await authenticateOAuth(request.headers.get("authorization"), grants, config.oauth!) : authenticateOpaque(request.headers.get("authorization"), grants);
  const now = Date.now();
  for (const [key, item] of buckets) if (now - item.at >= 60000) buckets.delete(key);
  const bucket = buckets.get(grant.id) ?? { at: now, count: 0 };
  if (++bucket.count > 120) throw new OperationError("rate_limited", "The per-process credential request limit is reached. Wait a minute; inspect existing operations before any write retry.", 429);
  buckets.set(grant.id, bucket);
  return { grant, selected: select(request.headers, grant) };
}
export async function handleMcp(request: Request): Promise<Response> {
  const requestId = randomUUID(), start = Date.now(); let status = 500;
  try {
    const { grant, selected } = await authenticateRequest(request);
    if (request.method !== "POST") { status = 405; return response({ error: { code: "method_not_allowed", message: "Use POST. The SDK is configured for stateless JSON responses, not a persistent event stream." } }, 405, { allow: "POST" }); }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new OperationError("unsupported_media_type", "Send application/json to the MCP endpoint; archives use the source-upload endpoint.", 415);
    const bytes = await boundedBytes(request, MAX_BODY);
    const bounded = new Request(request.url, { method: "POST", headers: request.headers, body: new Uint8Array(bytes), signal: request.signal });
    return await inApplication(grant, selected, async () => {
      const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "zenith", version: "0.2.0-dev.1" });
        for (const tool of operationTools.filter(t => grant.scopes.includes(t.scope))) {
          server.registerTool(tool.name, {
            description: tool.description,
            inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema),
            annotations: { readOnlyHint: !tool.mutates, destructiveHint: !!tool.destructive, idempotentHint: !tool.mutates || tool.name === "zenith_execute_plan", openWorldHint: true },
          }, async args => {
            try {
              // Authorization is checked on each HTTP request and again in the
              // tool/application layer. Client annotations never grant access.
              const data = redact(await callTool(tool.name, args, grant, selected));
              const structuredContent = { contractVersion: 2, data };
              const text = JSON.stringify(structuredContent);
              if (Buffer.byteLength(text) > MAX_RESULT / 2) throw new OperationError("response_too_large", "Narrow the query or use pagination. The tool result exceeded its bound.", 413);
              return { content: [{ type: "text" as const, text }], structuredContent };
            } catch (error) {
              const e = error instanceof OperationError ? error : new OperationError("operation_failed", "The tool could not complete. Inspect its receipt or operation and server diagnostics before any new write.");
              return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code: e.code, message: e.message, requestId }) }] };
            }
          });
        }
        return server;
      }, { responseMode: "json" });
      try {
        const result = await handler.fetch(bounded); status = result.status;
        result.headers.set("cache-control", "no-store"); result.headers.set("x-request-id", requestId); result.headers.set("x-content-type-options", "nosniff");
        return result;
      } finally { await handler.close(); }
    });
  } catch (error) { const result = failure(error, requestId); status = result.status; return result; }
  finally { console.info(JSON.stringify({ component: "agent-v2", requestId, status, durationMs: Date.now() - start })); }
}
export async function handleReview(request: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    const config = configuration();
    if (!config.enabled || !config.operatorOrigin || !config.operatorKeyPath || !writeAvailability().available) throw new OperationError("approval_unavailable", "The independent operator channel is not configured on this control host.", 503);
    validateOrigin(request, config.operatorOrigin);
    if (request.method !== "POST" || request.headers.has("authorization") || request.headers.has("cookie")) throw new OperationError("operator_auth_required", "The control channel accepts only signed operator requests, never agent tokens or browser cookies.", 403);
    const parsed: unknown = JSON.parse((await boundedBytes(request, 8192, 5000)).toString("utf8"));
    if (!object(parsed)) throw new OperationError("invalid_review", "Supply a signed review object.", 400);
    const review = parsed as unknown as ReviewRequest;
    verifyReview(await operatorKey(config.operatorKeyPath), config.operatorOrigin, review, request.headers.get("x-zenith-operator-signature"));
    const receipt = journal().forReview(review.receiptId);
    const grant: AgentGrant = { id: "operator", kind: "opaque", subject: review.subject, workspaceId: receipt.owner.workspaceId,
      projectIds: receipt.owner.projectId ? [receipt.owner.projectId] : [], environmentIds: receipt.owner.environmentId ? [receipt.owner.environmentId] : undefined,
      scopes: ["read"], issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    return await inApplication(grant, { workspaceId: receipt.owner.workspaceId, projectId: receipt.owner.projectId, environmentId: receipt.owner.environmentId }, async () => {
      liveMember(review.subject, receipt.owner.workspaceId, receipt.preview.requiredRole);
      liveMember(receipt.owner.subject, receipt.owner.workspaceId, "editor");
      await authorizeAppReview(receipt, review.subject);
      if (review.decision === "inspect") return response({ ...publicReceipt(receipt), intent: redact(receipt.intent) });
      const decided = journal().decide(receipt.id, review.digest, review.subject, review.decision, review.nonce, review.expiresAt);
      return response(publicReceipt(decided));
    });
  } catch (error) { return failure(error, requestId); }
}
export async function handleMetadata(request: Request): Promise<Response> {
  try { const config = configuration(); validateOrigin(request, config.origin); return response(metadata(config)); }
  catch (error) { return failure(error, randomUUID()); }
}

export async function handleSource(request: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    const { grant, selected } = await authenticateRequest(request);
    requireScope(grant, "publish");
    if (request.method !== "POST" || request.headers.get("content-type") !== "application/octet-stream") throw new OperationError("invalid_upload", "POST archive bytes as application/octet-stream through the local source helper.", 415);
    const appId = request.headers.get("x-zenith-app") ?? "", id = request.headers.get("x-zenith-upload-id") ?? "", hash = request.headers.get("x-zenith-source-sha256") ?? "";
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new OperationError("invalid_digest", "Supply the SHA-256 of the exact archive bytes.", 400);
    return await inApplication(grant, selected, async () => {
      await ensureBoot(); await permittedApp(authority().repos, grant, appId, true);
      const bytes = await boundedBytes(request, MAX_UPLOAD_BYTES, 10000);
      const upload = await acceptUpload(id, appId, bytes, hash, grant, selected);
      return response({ upload, notice: "Source accepted under the fixed frontend contract. Nothing was published; prepare and review a publish next." }, 201, { "x-request-id": requestId });
    });
  } catch (error) { return failure(error, requestId); }
}
