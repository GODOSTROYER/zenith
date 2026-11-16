/**
 * Migration 4 — independent human approval rounds for proposal and plan gates.
 * Old decisions remain immutable audit rows in round zero. A suspension opens
 * the next round; neither consumed nor leftover approvals from earlier rounds
 * can authorize it. The same human may review again, once per round.
 */
export const migration0004ApprovalRounds = {
  version: 4,
  name: "approval_rounds",
  sql: `
alter table platform.operations
  add column if not exists approval_round integer not null default 0 check (approval_round >= 0);
alter table platform.approvals
  add column if not exists approval_round integer not null default 0 check (approval_round >= 0);
alter table platform.approvals
  drop constraint if exists approvals_operation_id_approver_id_key;
create unique index if not exists approvals_op_round_approver
  on platform.approvals (operation_id, approval_round, approver_id);
`,
} as const;
