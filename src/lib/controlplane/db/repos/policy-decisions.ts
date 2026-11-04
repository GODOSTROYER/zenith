/**
 * Policy decision records: what the policy engine decided, under which bundle
 * version, for exactly which input digest. Append-only — a decision is never
 * updated; a re-evaluation is a new row.
 */
import type { PolicyDecisionRecord, PolicyOutcome, Sql } from "@/lib/controlplane/types";
import { ControlStoreError, optionalText, requireText } from "../errors";
import { assertNoSecretValues } from "../secrets";
import { json, jsonOrNull, newId, opt, requireDigest } from "../sql";

interface DecisionRow {
  id: string;
  workspace_id: string;
  operation_id: string | null;
  policy_version: string;
  input_digest: string;
  outcome: PolicyOutcome;
  reasons: PolicyDecisionRecord["reasons"];
  approval: PolicyDecisionRecord["approval"] | null;
  constraints: Record<string, unknown> | null;
  evaluated_at: string;
}

const COLUMNS = "id, workspace_id, operation_id, policy_version, input_digest, outcome, reasons, approval, constraints, evaluated_at";

const toDecision = (row: DecisionRow): PolicyDecisionRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  operationId: opt(row.operation_id),
  policyVersion: row.policy_version,
  inputDigest: row.input_digest,
  outcome: row.outcome,
  reasons: row.reasons,
  approval: opt(row.approval),
  constraints: opt(row.constraints),
  evaluatedAt: row.evaluated_at,
});

export type InsertPolicyDecisionInput = Omit<PolicyDecisionRecord, "id" | "evaluatedAt"> & { id?: string };

/** Record a decision. `operationId`, when given, must be an operation of the same workspace (enforced by a composite foreign key). */
export async function insert(sql: Sql, input: InsertPolicyDecisionInput): Promise<PolicyDecisionRecord> {
  if (!["allow", "deny", "require_approval"].includes(input.outcome))
    throw new ControlStoreError("invalid_input", "outcome must be allow, deny or require_approval.");
  assertNoSecretValues(input.reasons, "reasons");
  assertNoSecretValues(input.constraints, "constraints");
  const rows = await sql.query<DecisionRow>(
    `insert into platform.policy_decisions (id, workspace_id, operation_id, policy_version, input_digest, outcome, reasons, approval, constraints)
     values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb, $9::text::jsonb)
     returning ${COLUMNS}`,
    [
      input.id ?? newId("pol"),
      requireText("workspaceId", input.workspaceId),
      optionalText("operationId", input.operationId) ?? null,
      requireText("policyVersion", input.policyVersion, 128),
      requireDigest("inputDigest", input.inputDigest),
      input.outcome,
      json(input.reasons ?? []),
      jsonOrNull(input.approval),
      jsonOrNull(input.constraints),
    ]
  );
  return toDecision(rows[0]);
}

export async function get(sql: Sql, workspaceId: string, id: string): Promise<PolicyDecisionRecord | null> {
  const rows = await sql.query<DecisionRow>(
    `select ${COLUMNS} from platform.policy_decisions where workspace_id = $1 and id = $2`,
    [requireText("workspaceId", workspaceId), requireText("id", id)]
  );
  return rows.length ? toDecision(rows[0]) : null;
}

/** Decisions recorded for one operation, newest first. */
export async function listForOperation(sql: Sql, workspaceId: string, operationId: string): Promise<PolicyDecisionRecord[]> {
  const rows = await sql.query<DecisionRow>(
    `select ${COLUMNS} from platform.policy_decisions
      where workspace_id = $1 and operation_id = $2 order by evaluated_at desc, id`,
    [requireText("workspaceId", workspaceId), requireText("operationId", operationId)]
  );
  return rows.map(toDecision);
}
