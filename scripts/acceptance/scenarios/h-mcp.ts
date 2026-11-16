/** Demo H drives configured MCP roles; tool names/results are data. Approval is
 * observed through the canonical control-plane ledger, never issued here. */
import { assertNoCredentialLeak, credentialPatternsIn } from "@/lib/credentials/redact";
import type { McpToolResult } from "../clients/mcp";
import { requireClient, type PassCriterion, type ScenarioContext, type ScenarioDefinition } from "../types";
import { checker, configPrerequisite, cp, awaitApproval, awaitTerminal } from "./_shared";
import { trackOperation } from "../lifecycle";

const CRITERIA: readonly PassCriterion[] = [
  { id: "connect", text: "Initialize and listTools succeed, and every configured tool exists." },
  { id: "inspect", text: "The configured inspect tool returns a non-error result." },
  { id: "propose-gated", text: "The proposal creates an awaiting_approval operation without executing it." },
  { id: "human-approval", text: "A separate human approves the proposal through the browser ledger." },
  { id: "execute-after-approval", text: "Execution succeeds only after the observed human approval." },
  { id: "no-secrets", text: "Every raw MCP result was scanned and contains no credential patterns or configured tokens." },
];
const C = checker("H", CRITERIA);
async function tool(ctx: ScenarioContext, role: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const name = ctx.config.mcpTools?.[role];
  if (!name) throw new Error(`MCP role ${role} is not configured.`);
  const result = await requireClient(ctx.mcp, "MCP client").callTool(name, args);
  const leaks = result.credentialPatterns ?? credentialPatternsIn(JSON.stringify(result));
  ctx.state.set("h.leaks", [...(ctx.state.get("h.leaks") as string[] ?? []), ...leaks]);
  assertNoCredentialLeak(result, { secrets: [ctx.config.apiToken ?? "", ctx.config.mcpToken ?? ""] });
  ctx.evidence.logQuery("H", { source: "mcp", query: role, lines: [JSON.stringify(result)] });
  if (result.isError) throw new Error(`MCP ${role} tool returned isError.`);
  return result;
}
function operationId(r: McpToolResult): string {
  let v = r.structured;
  if (!v) { try { v = JSON.parse(r.text); } catch { throw new Error("MCP proposal must return structured JSON with an operation id."); } }
  const obj = v as { operationId?: unknown; operation?: { id?: unknown } };
  const id = obj.operationId ?? obj.operation?.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("MCP proposal returned no usable operation id.");
  return id;
}
export const demoH: ScenarioDefinition = {
  id: "H", title: "MCP agent inspect, propose, approve, execute", summary: "Drive the same capability path over MCP, waiting for a human approval and scanning raw results for secrets.",
  needs: { cloud: "none", controlPlane: true, temporal: false }, mutates: true, createsResources: false, dependsOn: [],
  prerequisites: [configPrerequisite("mcp-config", "MCP endpoint, role map, API and sandbox workspace are configured", (c) => !!c.mcpUrl && !!c.apiUrl && !!c.apiToken && !!c.workspaceId && ["inspect", "propose", "status"].every((r) => !!c.mcpTools?.[r]), "set MCP_URL, MCP_TOOLS (inspect/propose/status), API_URL, API_TOKEN and WORKSPACE_ID")],
  steps: [
    { id: "connect", title: "Initialize and discover configured tools", effect: "read", plan: () => ["MCP initialize + notifications/initialized + tools/list", "require every configured role's tool present"],
      async run(ctx) {
        const m = requireClient(ctx.mcp, "MCP client");
        await m.initialize(); const tools = await m.listTools();
        const found = Object.values(ctx.config.mcpTools!).every((n) => tools.some((t) => t.name === n));
        C.expect(ctx, "connect", found, `${tools.length} tools discovered; configured roles present ${found}.`);
        if (!found) throw new Error("MCP roles do not match server tool names.");
      } },
    { id: "inspect", title: "Inspect the sandbox workspace", effect: "read", plan: () => ["call configured inspect tool for this workspace (read-only)"],
      async run(ctx) { await tool(ctx, "inspect", { workspaceId: ctx.config.workspaceId }); C.pass(ctx, "inspect"); } },
    { id: "propose", title: "Propose a read-only plan and verify its approval gate", effect: "mutate",
      plan: () => ["call configured propose tool for infrastructure.plan, run-scoped reason/idempotency key", "read the returned operation from the ledger; require awaiting_approval and no operation.started event"],
      async run(ctx) {
        // A plan-only capability cannot create cloud resources if the server
        // policy unexpectedly allows execution. A dedicated approval policy is required.
        const r = await tool(ctx, "propose", { capability: "infrastructure.plan", scope: { workspaceId: ctx.config.workspaceId }, reason: `MCP live acceptance ${ctx.runId}`, idempotencyKey: `${ctx.runId}-h-plan` });
        const id = operationId(r); ctx.state.set("h.operationId", id); trackOperation(ctx, id);
        const detail = await cp(ctx).getOperation(id);
        const events = (await cp(ctx).listOperationEvents(id)).events;
        const gated = detail.operation.status === "awaiting_approval" && detail.operation.approvalRequired && !events.some((e) => e.type === "operation.started");
        C.expect(ctx, "propose-gated", gated, `operation ${detail.operation.status}; approvalRequired ${detail.operation.approvalRequired}.`);
        if (!gated) throw new Error("Proposal did not hold for approval; configure a dedicated approval-required policy.");
        const approval = await awaitApproval(ctx, { operation: detail.operation, decision: { outcome: "require_approval", reasons: [] }, replayed: false });
        C.expect(ctx, "human-approval", approval.mode === "human" && approval.approverIsHuman, "Approval observed in the canonical ledger; approver must differ from proposer.");
        if (!approval.approverIsHuman) throw new Error("Human approval not established.");
      } },
    { id: "execute", title: "Execute/status after approval and scan all results", effect: "mutate",
      plan: () => ["call optional execute tool only after human approval, then status", "wait for terminal succeeded through the ledger", "fail no-secrets if any raw result matched a credential pattern (redaction does not turn a leak into a pass)"],
      async run(ctx) {
        const operationId = ctx.state.get("h.operationId") as string;
        if (ctx.config.mcpTools?.execute) await tool(ctx, "execute", { operationId });
        await tool(ctx, "status", { operationId });
        const op = await awaitTerminal(ctx, "H", operationId, ctx.config.deployTimeoutMs);
        C.expect(ctx, "execute-after-approval", op.status === "succeeded", `operation ended ${op.status}.`);
        const leaks = ctx.state.get("h.leaks") as string[] ?? [];
        C.expect(ctx, "no-secrets", leaks.length === 0, leaks.length ? `Raw results matched: ${[...new Set(leaks)].join(", ")}.` : "All raw tool results scanned before redaction.");
      } },
  ], passCriteria: CRITERIA, proves: ["MCP tool discovery, inspection and a gated plan use the canonical approval/execution ledger without exposing credential values."],
  cannotProve: ["Every coding agent's UX, arbitrary tool schemas, or a billable deployment: this harness uses a safe plan capability.", "Names are configured, but inspect/propose/status/execute argument shapes must match the v3 server; schema changes need an adapter."],
  blockedOn: ["Needs merged v3 MCP, configured tool roles, a disposable sandbox workspace and a human approval-required plan policy.", "The current v3 tool names and schemas are unmerged; these calls have only fake-server coverage."], runsLocally: false, costNote: "plan only; no billable infrastructure created by Demo H.",
};
