/** Permanent encrypted outcomes, independent of mutable job/operation projections. */
import { sha256Hex } from "@/lib/controlplane/digest";
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError } from "../errors";
import { assertNoSecretValues } from "../secrets";
import { RunnerStoreError, snapshotOutcome, type AgentEffectReceipt, type SettleOutcomeInput, type SettledOutcome } from "@/lib/runners/ports";
import type { AgentKind } from "@/lib/runners/types";
import type { SealedBox } from "@/lib/runners/seal";

interface Row {
  workspace_id: string; agent_kind: AgentKind; agent_id: string; job_id: string; operation_id: string | null;
  job_kind: string; capability: string; envelope_digest: string; agent_key_digest: string; logical_digest: string;
  projection_status: AgentEffectReceipt["projectionStatus"]; reported_status: AgentEffectReceipt["reportedStatus"];
  claimed_at: string; received_at: string; sealed: SealedBox;
}
const receipt = (r: Row): AgentEffectReceipt => ({
  workspaceId: r.workspace_id, agentKind: r.agent_kind, agentId: r.agent_id, jobId: r.job_id,
  operationId: r.operation_id ?? undefined, jobKind: r.job_kind, capability: r.capability,
  envelopeDigest: r.envelope_digest, agentKeyDigest: r.agent_key_digest, logicalDigest: r.logical_digest,
  projectionStatus: r.projection_status, reportedStatus: r.reported_status, claimedAt: r.claimed_at,
  receivedAt: r.received_at, sealed: r.sealed,
});

// Closed literal SQL families, never identifiers or proof callbacks supplied by a caller.
const RUNNER = {
  agent: "select id from platform.runners where workspace_id=$1 and id=$2 and public_key=$3 and status='active' for share",
  job: "select status,claimed_at,envelope from platform.runner_jobs where workspace_id=$1 and runner_id=$2 and id=$3 for update",
  insert: `insert into platform.agent_effect_receipts
    (workspace_id,agent_kind,agent_id,job_id,runner_job_id,machine_request_id,operation_id,job_kind,capability,
     envelope_digest,agent_key_digest,logical_digest,projection_status,reported_status,claimed_at,sealed)
    select j.workspace_id,'runner',j.runner_id,j.id,j.id,null,j.operation_id,j.kind,j.capability,
      $4,$5,$6,j.status,$7,j.claimed_at,$8::text::jsonb
    from platform.runner_jobs j where j.workspace_id=$1 and j.runner_id=$2 and j.id=$3
      and j.claimed_at is not null and j.status in ('claimed','running','cancelled','timed_out') returning *`,
  settle: `update platform.runner_jobs set status=$4,result=$5::text::jsonb,error=$6,
    settled_at=clock_timestamp(),lease_until=null
    where workspace_id=$1 and runner_id=$2 and id=$3 and claimed_at is not null and status in ('claimed','running') returning id`,
};
const MACHINE = {
  agent: "select id from platform.machines where workspace_id=$1 and id=$2 and public_key=$3 and status='active' and transport='zenithd' for share",
  job: "select status,claimed_at,envelope from platform.machine_requests where workspace_id=$1 and machine_id=$2 and id=$3 for update",
  insert: `insert into platform.agent_effect_receipts
    (workspace_id,agent_kind,agent_id,job_id,runner_job_id,machine_request_id,operation_id,job_kind,capability,
     envelope_digest,agent_key_digest,logical_digest,projection_status,reported_status,claimed_at,sealed)
    select j.workspace_id,'machine',j.machine_id,j.id,null,j.id,j.operation_id,j.operation,j.capability,
      $4,$5,$6,j.status,$7,j.claimed_at,$8::text::jsonb
    from platform.machine_requests j where j.workspace_id=$1 and j.machine_id=$2 and j.id=$3
      and j.claimed_at is not null and j.status in ('claimed','running','cancelled','timed_out') returning *`,
  settle: `update platform.machine_requests set status=$4,result=$5::text::jsonb,error=$6,
    settled_at=clock_timestamp(),lease_until=null
    where workspace_id=$1 and machine_id=$2 and id=$3 and claimed_at is not null and status in ('claimed','running') returning id`,
};

export async function get(sql: Sql, input: { workspaceId: string; agentKind: AgentKind; jobId: string }): Promise<AgentEffectReceipt | null> {
  const rows = await sql.query<Row>("select * from platform.agent_effect_receipts where workspace_id=$1 and agent_kind=$2 and job_id=$3", [input.workspaceId, input.agentKind, input.jobId]);
  return rows.length ? receipt(rows[0]) : null;
}

async function record(sql: Sql, kind: AgentKind, input: SettleOutcomeInput): Promise<SettledOutcome> {
  const i = snapshotOutcome(input);
  assertNoSecretValues(i.sealed);
  assertNoSecretValues(i.result);
  let error = i.error;
  if (error !== undefined) {
    try { assertNoSecretValues(error); }
    catch (e) {
      if (!(e instanceof ControlStoreError) || e.code !== "secret_material") throw e;
      error = "[error withheld: it matched a secret pattern]";
    }
  }
  const queries = kind === "runner" ? RUNNER : MACHINE;
  return sql.tx(async tx => {
    // Revocation takes the agent row before cancelling jobs. Keep the same
    // order here; no event/SDK work occurs in this replayable transaction.
    const agents = await tx.query(queries.agent, [i.workspaceId, i.agentId, i.authenticatedPublicKey]);
    if (!agents.length) throw new RunnerStoreError("agent_revoked", "The authenticated agent is no longer active under this key.");
    const jobs = await tx.query<{ status: string; claimed_at: string | null; envelope: string }>(queries.job, [i.workspaceId, i.agentId, i.jobId]);
    const job = jobs[0];
    if (!job) throw new RunnerStoreError("not_found", "No such job for this agent.");
    const existing = await get(tx, { workspaceId: i.workspaceId, agentKind: kind, jobId: i.jobId });
    if (existing) {
      if (existing.agentId !== i.agentId || existing.logicalDigest !== i.logicalDigest
        || existing.envelopeDigest !== sha256Hex(job.envelope) || existing.agentKeyDigest !== sha256Hex(i.authenticatedPublicKey))
        throw new RunnerStoreError("conflict", "A different authenticated outcome is already retained for this job.");
      return { disposition: "duplicate", receipt: existing };
    }
    if (!job.claimed_at || !["claimed", "running", "cancelled", "timed_out"].includes(job.status))
      throw new RunnerStoreError("conflict", "This job has no eligible delivered outcome to retain.");
    const rows = await tx.query<Row>(queries.insert, [i.workspaceId, i.agentId, i.jobId,
      sha256Hex(job.envelope), sha256Hex(i.authenticatedPublicKey), i.logicalDigest, i.status, JSON.stringify(i.sealed)]);
    if (!rows.length) throw new RunnerStoreError("conflict", "The outcome could not be retained for this assignment.");
    const late = job.status === "cancelled" || job.status === "timed_out";
    if (!late) {
      const changed = await tx.query(queries.settle, [i.workspaceId, i.agentId, i.jobId, i.status, JSON.stringify(i.result), error ?? null]);
      if (!changed.length) throw new RunnerStoreError("conflict", "The active outcome could not be settled.");
    }
    return { disposition: late ? "late" : "settled", receipt: receipt(rows[0]) };
  });
}

export const recordRunnerOutcome = (sql: Sql, input: SettleOutcomeInput): Promise<SettledOutcome> => record(sql, "runner", input);
export const recordMachineOutcome = (sql: Sql, input: SettleOutcomeInput): Promise<SettledOutcome> => record(sql, "machine", input);
