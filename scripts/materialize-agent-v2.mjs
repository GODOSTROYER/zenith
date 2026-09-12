#!/usr/bin/env node
/** Checked, idempotent integration edits. CI resolves the pinned lockfile. */
import { readFile, writeFile } from 'node:fs/promises';
const edit = async (path, before, after) => {
  const source = await readFile(path, 'utf8');
  if (source.includes(after)) return;
  if (source.split(before).length !== 2) throw new Error(`Refusing a non-unique or changed integration anchor in ${path}`);
  await writeFile(path, source.replace(before, after));
};
await edit('src/lib/agent-access/zenith-reader.ts', 'async function call(name: string,', 'export async function readerCall(name: string,');
await edit('src/lib/agent-access/zenith-reader.ts', '\n  call,\n', '\n  call: readerCall,\n');
await edit('src/lib/agent-operations/journal.ts', '"cancel" | "publish" | "rollback_app";', '"cancel" | "approve_deployment" | "publish" | "rollback_app";');
await edit('src/lib/agent-operations/application.ts', 'type Intent, type Owner, type Preview', 'type Intent, type Preview');
await edit('src/middleware.ts', 'if (request.nextUrl.pathname === "/api/agent/v1/mcp") return NextResponse.next({ request });',
  'if (["/api/agent/v1/mcp", "/api/agent/v2/mcp", "/api/agent/v2/review", "/api/agent/v2/source", "/.well-known/oauth-protected-resource/api/agent/v2/mcp"].includes(request.nextUrl.pathname)) return NextResponse.next({ request });');
await edit('src/lib/agent-operations/application.ts', 'import { join } from "node:path";', 'import { join } from "node:path";\nimport { existsSync } from "node:fs";\nimport { diffManifests, isStatefulKind } from "@/lib/domain/graph";');
await edit('src/lib/agent-operations/application.ts', '  assertWrites(); claimDataDir(env().ZENITH_DATA);', '  if (isServerless() || isPostgres()) throw new OperationError("journal_unavailable", "This control-host journal is unavailable in a Postgres/serverless process. Read the recorded operation on its original control host.", 503);\n  claimDataDir(env().ZENITH_DATA);');
await edit('src/lib/agent-operations/application.ts', '  if (!value) { value = openPrivateJournal(path); value.recoverInterrupted(); map.set(path, value); }', '  if (!value) {\n    if (!existsSync(path) && process.env.ZENITH_AGENT_WRITES !== "1") throw new OperationError("journal_unavailable", "No reviewed-operation journal exists on this control host.", 404);\n    value = openPrivateJournal(path); value.recoverInterrupted(); map.set(path, value);\n  }');
await edit('src/lib/agent-operations/application.ts', '    return { kind: "rollback", input: { toRevisionId: revision.id } };', '    const deployed = e.deployedRevisionId ? q.revisionManifest(e.deployedRevisionId) : undefined;\n    if (deployed && !e.policies.allowStatefulDeletion) {\n      const changes = diffManifests(deployed, revision.manifest);\n      if (changes.items.some(i => i.op === "delete" && deployed.resources.some(r => r.id === i.nodeId && r.ownership === "managed" && isStatefulKind(r.kind))))\n        throw new OperationError("stateful_deletion_denied", "This rollback removes managed stateful resources. It is blocked by the environment policy; rollback cannot recover deleted data.");\n    }\n    return { kind: "rollback", input: { toRevisionId: revision.id } };');
await edit('src/lib/agent-operations/application.ts', '  const action = actionFor(receipt.intent, grant, selected);\n  // The awaited work', '  if (receipt.intent.kind === "publish" || receipt.intent.kind === "rollback_app") {\n    const { executeHosted } = await import("./hosted");\n    return executeHosted(receipt, key, grant, selected);\n  }\n  // The awaited work');
await edit('src/lib/agent-operations/application.ts', '  const operationId = claimed.operation.id;\n  let result:', '  const operationId = claimed.operation.id;\n  const action = actionFor(receipt.intent, grant, selected);\n  let result:');
await edit('src/lib/agent-operations/application.ts', '    remoteAuthentication: "Maintained authorization-provider introspection with issuer, resource audience, expiration and enrollment checks." };', '    mode: grant.scopes.includes("execute") ? "reviewed-operations" : "read-only",\n    unavailable: { postgresWrites: "Not enabled: cross-store fencing is not implemented.", arbitraryPublishing: "Only the pinned React/Vite frontend source contract is supported.", nativeModelValidation: "Recorded separately from protocol and application integration tests." },\n    remoteAuthentication: "Maintained authorization-provider introspection with issuer, resource audience, expiration and enrollment checks." };');
await edit('src/lib/agent-operations/hosted.ts', 'export async function permittedApp(', 'export const hostedIdentity = { verify: verifyHostedIdentity };\n\nexport async function permittedApp(');
const hostedPath = 'src/lib/agent-operations/hosted.ts';
let hosted = await readFile(hostedPath, 'utf8');
hosted = hosted.replaceAll('await verifyHostedIdentity(grant.subject)', 'await hostedIdentity.verify(grant.subject)').replaceAll('await verifyHostedIdentity(subject)', 'await hostedIdentity.verify(subject)');
await writeFile(hostedPath, hosted);
await edit('src/lib/agent-operations/tools.ts', 'import { OperationError } from "./journal";', 'import { OperationError } from "./journal";\nimport { prepareHosted, readHosted, hostedOperationView } from "./hosted";');
await edit('src/lib/agent-operations/tools.ts', '  ...readerTools.map(t => ({ ...t, mutates: false })),', `  ...readerTools.map(t => ({ ...t, mutates: false })),
  tool("zenith_get_source_contract", "Read the supported private-app frontend contract and source limits. No source bytes are returned.", {}, [], "read"),
  tool("zenith_list_apps", "List only private apps authorized by both this enrollment and a current app grant.", {}, [], "read"),
  tool("zenith_get_app", "Inspect a permitted private app and up to 50 releases. Workspace membership alone never grants app access.", { appId: string }, ["appId"], "read"),
  tool("zenith_prepare_publish", "Prepare publication of an immutable uploaded source. Requires publish scope, a live identity, an app-owner grant and independent review. Never send source bytes or base64 in tool arguments.", { ...selection, requestId: uuid, appId: string, uploadId: uuid }, ["requestId", "appId", "uploadId"], "publish", true),
  tool("zenith_prepare_app_rollback", "Prepare private-app code rollback to a named compatible release. Customer records are not rolled back. Requires current app-owner access and independent review.", { ...selection, requestId: uuid, appId: string, releaseId: string }, ["requestId", "appId", "releaseId"], "publish", true),`);
await edit('src/lib/agent-operations/tools.ts', '  switch (name) {\n    case "zenith_get_receipt":', '  switch (name) {\n    case "zenith_prepare_publish": return prepareHosted("publish", args, String(args.requestId), grant, scoped);\n    case "zenith_prepare_app_rollback": return prepareHosted("rollback_app", args, String(args.requestId), grant, scoped);\n    case "zenith_get_source_contract":\n    case "zenith_list_apps":\n    case "zenith_get_app": return readHosted(name, args, grant);\n    case "zenith_get_receipt":');
await edit('src/lib/agent-operations/tools.ts', 'case "zenith_get_operation": return operationView(journal()', 'case "zenith_get_operation": return hostedOperationView(journal()');
await edit('src/lib/agent-operations/tools.ts', 'publicReceipt, operationView, readTool', 'publicReceipt, readTool');
await edit('src/lib/agent-operations/http.ts', 'import { redact } from "@/lib/agent-access/security";', 'import { redact } from "@/lib/agent-access/security";\nimport { acceptUpload, permittedApp, authorizeAppReview } from "./hosted";\nimport { MAX_UPLOAD_BYTES } from "./uploads";\nimport { authority } from "@/lib/hosted/authority";\nimport { ensureBoot } from "@/lib/server/boot";\nimport { requireScope } from "./access";');
await edit('src/lib/agent-operations/http.ts', 'const data = await callTool(tool.name, args, grant, selected);', 'const data = redact(await callTool(tool.name, args, grant, selected));');
await edit('src/lib/agent-operations/http.ts', '      if (review.decision === "inspect") return response', '      await authorizeAppReview(receipt, review.subject);\n      if (review.decision === "inspect") return response');
const httpPath = 'src/lib/agent-operations/http.ts';
let http = await readFile(httpPath, 'utf8');
if (!http.includes('export async function handleSource(')) {
  http += `\nexport async function handleSource(request: Request): Promise<Response> {
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
}\n`;
  await writeFile(httpPath, http);
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
pkg.dependencies['@modelcontextprotocol/server'] = '2.0.0';
pkg.devDependencies['@modelcontextprotocol/client'] = '2.0.0';
pkg.scripts['test:agent'] = 'vitest run tests/agent-operations';
await writeFile('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
