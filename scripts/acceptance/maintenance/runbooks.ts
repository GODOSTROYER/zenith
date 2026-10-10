/** Real browser/session routes -> default broker -> signed registered zenithd -> durable audit/evidence. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { openPlatformDb, repos } from "@/lib/controlplane/db";
import { verifyAuditChain } from "@/lib/machines/runbooks/audit";
import type { RunbookAuditRecord, RunbookRunRecord, RunbookStepRecord } from "@/lib/machines/runbooks/ports";
import { runbookOf } from "@/lib/execution/semantics/collect";
import { localUrl, seededEpoch } from "./preconditions";

export async function registeredRunbookAcceptance(): Promise<Record<string, unknown>> {
  assert(process.env.ZENITH_TEST_RUNBOOK_DELIVERY === "1", "Not run: needs the real Mac default API and registered zenithd.");
  const origin = localUrl(process.env.ZENITH_J4_API_ORIGIN ?? "", ["http:", "https:"]).origin;
  localUrl(process.env.ZENITH_PLATFORM_DB_URL ?? "", ["postgres:", "postgresql:"]);
  const cookie = (await readFile(process.env.ZENITH_J4_BROWSER_COOKIE_FILE!, "utf8")).trim();
  assert(cookie.length > 0 && !/[\r\n]/.test(cookie), "Requires a signed-in local operator's Cookie header file.");
  const target = JSON.parse(await readFile(process.env.ZENITH_J4_TARGET_FILE!, "utf8")) as { workspaceId: string; targetId: string; environmentId: string; resourceId: string };
  const db = await openPlatformDb({ kind: "postgres", url: process.env.ZENITH_PLATFORM_DB_URL!, migrate: false, max: 2 });
  const request = async (route: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL(route, origin), { method: body === undefined ? "GET" : "POST", headers: { cookie, origin, "sec-fetch-site": "same-origin", "x-zenith-workspace": target.workspaceId, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(15_000) });
    assert(response.ok, "Default signed-in runbook HTTP request failed.");
    return await response.json() as Record<string, unknown>;
  };
  const waitRun = async (id: string): Promise<{ run: RunbookRunRecord; steps: RunbookStepRecord[]; audit: RunbookAuditRecord[] }> => {
    const end = Date.now() + 180_000;
    do {
      const detail = await request(`/api/platform/v1/runbooks/runs/${id}`) as unknown as { run: RunbookRunRecord; steps: RunbookStepRecord[]; audit: RunbookAuditRecord[] };
      if (!["approved", "running", "pending_approval"].includes(detail.run.status)) return detail;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < end);
    throw new Error("Default signed runbook did not finish before its deadline.");
  };
  const runbookId = `j4-${randomUUID()}`;
  const activeRuns: string[] = [];
  let pendingCancellationId: string | undefined;
  try {
    const epoch = await seededEpoch(db);
    const machine = await repos.machines.getMachine(db, target.workspaceId, target.targetId);
    assert(machine?.transport === "zenithd" && machine.status === "active" && !machine.stale && machine.environmentId === target.environmentId && machine.capabilities.includes("machine.inspect"), "Requires a real active registered machine bound to the fixture environment.");
    const rows = await db.query<{ created_at: string; unknown: boolean }>("select created_at::text, platform.cleanup_scope_epoch_unknown(workspace_id, project_id, id) as unknown from public.environments where workspace_id=$1 and id=$2", [target.workspaceId, target.environmentId]);
    assert(rows.length === 1 && rows[0].unknown === false && Date.parse(rows[0].created_at) >= Date.parse(epoch), "Seed the fixture environment after the immutable cleanup epoch.");
    const { version } = await request("/api/platform/v1/runbooks", { runbookId, definition: { schemaVersion: 1, name: "J4 registered inspection", steps: [{ id: "inspect", title: "Inspect registered machine", operation: "machine.inspect", args: {} }] } }) as { version: { version: number; definitionDigest: string } };
    const targets = [{ transport: "zenithd", targetId: target.targetId, environmentId: target.environmentId, resourceId: target.resourceId }];
    const { run } = await request(`/api/platform/v1/runbooks/${runbookId}/runs`, { version: version.version, targets, maxRunDurationSec: 120, maxParallelTargets: 1 }) as { run: RunbookRunRecord };
    activeRuns.push(run.id);
    const detail = await waitRun(run.id);
    assert(detail.run.status === "succeeded" && detail.steps.length === 1 && detail.steps[0].status === "succeeded" && detail.steps[0].evidenceId, "Registered agent delivery did not produce successful durable evidence.");
    assert(verifyAuditChain(detail.audit), "Run audit chain is broken.");
    const join = detail.audit.find(event => event.event === "run.step.authorized");
    assert(join && typeof join.detail.operationId === "string", "Broker operation audit join is missing.");
    const op = await repos.operations.get(db, target.workspaceId, join.detail.operationId);
    assert(op?.status === "succeeded", "Default broker did not settle the step operation.");
    assert.deepEqual(runbookOf(op.proposal.input), { runbookId, version: version.version, definitionDigest: version.definitionDigest });
    const evidence = await repos.evidence.get(db, target.workspaceId, detail.steps[0].evidenceId!);
    assert(evidence && !evidence.simulated, "Registered delivery lacks non-simulated durable machine evidence.");
    const deliveries = await db.query<{ status: string; started_at: string | null }>("select status, started_at::text from platform.machine_requests where workspace_id=$1 and operation_id=$2", [target.workspaceId, op.id]);
    assert(deliveries.length === 1 && deliveries[0].status === "succeeded" && deliveries[0].started_at, "Actual signed agent queue delivery is missing or duplicated.");
    // Publish a high-risk escape hatch: request remains pending until independently approved, then cancellation must persist.
    const next = await request("/api/platform/v1/runbooks", { runbookId, definition: { schemaVersion: 1, name: "J4 cancel before approval", steps: [{ id: "exec", title: "Approved escape hatch only", operation: "machine.exec", args: { argv: ["/bin/true"], timeoutSec: 10 }, timeoutSec: 10 }] } }) as { version: { version: number } };
    assert(next.version.version === version.version + 1);
    const pending = await request(`/api/platform/v1/runbooks/${runbookId}/runs`, { version: next.version.version, targets, maxRunDurationSec: 120, maxParallelTargets: 1 }) as { run: RunbookRunRecord };
    activeRuns.push(pending.run.id);
    pendingCancellationId = pending.run.id;
    assert(pending.run.status === "pending_approval", "Raw exec bypassed independent human approval.");
    await request(`/api/platform/v1/runbooks/runs/${pending.run.id}/cancel`, { reason: "Owned J4 acceptance cancellation" });
    const cancelled = await waitRun(pending.run.id);
    assert(cancelled.run.status === "cancelled" && cancelled.steps.length === 0 && verifyAuditChain(cancelled.audit) && cancelled.audit.some(event => event.event === "run.cancel_requested"), "Cancellation/audit did not persist before delivery.");
    assert(await seededEpoch(db) === epoch);
    return { schema: 1, level: "local_engine", registeredSignedDelivery: true, brokerSemanticsBound: true, oneDelivery: true, durableEvidence: true, auditJoin: true, pendingCancellation: true, rawExecApprovalRequired: true, epochPreserved: true };
  } finally {
    const errors: unknown[] = [];
    for (const id of activeRuns) {
      try {
        let detail = await request(`/api/platform/v1/runbooks/runs/${id}`) as unknown as { run: RunbookRunRecord; steps: RunbookStepRecord[]; audit: RunbookAuditRecord[] };
        if (["approved", "running", "pending_approval"].includes(detail.run.status)) {
          await request(`/api/platform/v1/runbooks/runs/${id}/cancel`, { reason: "Owned J4 cleanup" });
          detail = await waitRun(id);
        }
        assert(!["approved", "running", "pending_approval"].includes(detail.run.status), "J4 run cancellation did not settle; retain the namespace/database.");
        if (id === pendingCancellationId) {
          assert(detail.run.status === "cancelled", "Pre-approval cancellation did not persist; retain the namespace/database.");
          assert(detail.steps.length === 0 && !detail.audit.some(event => event.event === "run.step.authorized"), "Pre-approval cancellation reached step authorization; retain the namespace/database.");
          const deliveries = await db.query<{ id: string }>("select mr.id from platform.machine_requests mr join platform.machine_runbook_run_steps s on s.workspace_id=mr.workspace_id and s.operation_id=mr.operation_id where s.workspace_id=$1 and s.run_id=$2", [target.workspaceId, id]);
          assert(deliveries.length === 0, "Pre-approval cancellation left a machine delivery; retain the namespace/database.");
        }
      } catch (error) {
        errors.push(error);
      }
    }
    try { await db.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Owned runbook cleanup is unconfirmed; retain the namespace/database.");
  }
}
