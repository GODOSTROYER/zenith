/**
 * `approvalEligibility` decides whether Approve and Reject are offered, and the
 * sentence shown when they are not. The table below is the contract: one row per
 * way a viewer can be turned away, plus the orderings that decide which reason
 * wins when several apply.
 */
import { describe, expect, it } from "vitest";
import {
  approvalEligibility,
  approvalProgress,
  requesterId,
  type ApprovalViewer,
  type IneligibleReason,
} from "@/components/platform/approval-eligibility";
import type { ApprovalRecord, OperationRecord, PolicyDecisionRecord } from "@/lib/controlplane/types";
import { DIGEST, DIGEST_2, EARLIER, LATER, NOW, NOW_MS, POLICY_VERSION, approval, decision, operation } from "./fixtures";

const APPROVER: ApprovalViewer = { id: "user_other", role: "admin" };

interface Case {
  name: string;
  viewer: ApprovalViewer;
  op?: Partial<OperationRecord>;
  /** an explicit `undefined` means "no policy decision was loaded" */
  decision?: PolicyDecisionRecord;
  approvals?: ApprovalRecord[];
  now?: string;
  /** undefined = eligible */
  reason?: IneligibleReason;
  /** a fragment of the human message */
  says?: string;
}

const CASES: Case[] = [
  { name: "an admin who is not the requester may decide", viewer: APPROVER },
  { name: "an editor may decide when policy asks for editors", viewer: { id: "user_editor", role: "editor" } },

  { name: "a viewer role is below the minimum", viewer: { id: "user_v", role: "viewer" }, reason: "role_too_low", says: "editor role or higher" },
  { name: "a non-member is below the minimum", viewer: { id: "user_x", role: "none" }, reason: "role_too_low", says: "not a member" },
  {
    name: "an editor is below an admin-only requirement",
    viewer: { id: "user_editor", role: "editor" },
    decision: decision({ approval: { count: 1, minRole: "admin", separationOfDuties: true } }),
    reason: "role_too_low",
    says: "admin role or higher",
  },

  {
    name: "the requester cannot approve under separation of duties",
    viewer: { id: "user_requester", role: "admin" },
    reason: "is_requester",
    says: "You requested this change",
  },
  {
    name: "the requester may approve when separation of duties is off",
    viewer: { id: "user_requester", role: "admin" },
    decision: decision({ approval: { count: 1, minRole: "editor", separationOfDuties: false } }),
  },
  {
    name: "the human behind an agent proposal is the requester",
    viewer: { id: "user_owner", role: "admin" },
    op: { principal: { kind: "integration", id: "int_1", name: "Codex", onBehalfOf: "user_owner" } },
    reason: "is_requester",
    says: "on your behalf",
  },
  {
    name: "an unrelated human may approve an agent proposal",
    viewer: APPROVER,
    op: { principal: { kind: "navigator", id: "nav_1", name: "Navigator", onBehalfOf: "user_owner" } },
  },

  { name: "an approved operation is not awaiting a decision", viewer: APPROVER, op: { status: "approved" }, reason: "not_awaiting_approval", says: "not waiting for a decision" },
  { name: "a running operation is not awaiting a decision", viewer: APPROVER, op: { status: "running" }, reason: "not_awaiting_approval" },
  { name: "a rejected operation is not awaiting a decision", viewer: APPROVER, op: { status: "rejected" }, reason: "not_awaiting_approval" },
  { name: "an uncertain operation is not awaiting a decision", viewer: APPROVER, op: { status: "uncertain" }, reason: "not_awaiting_approval" },

  { name: "an expired proposal cannot be decided", viewer: APPROVER, op: { expiresAt: EARLIER }, reason: "expired", says: "expired" },
  { name: "a proposal expiring exactly now is expired", viewer: APPROVER, op: { expiresAt: NOW }, reason: "expired" },
  { name: "an unreadable expiry fails closed", viewer: APPROVER, op: { expiresAt: "not a date" }, reason: "expired", says: "cannot read" },

  {
    name: "the digest moved after the viewer opened the page",
    viewer: { ...APPROVER, reviewedDigest: DIGEST_2 },
    reason: "digest_changed",
    says: "changed after you opened it",
  },
  { name: "the digest the viewer reviewed is current", viewer: { ...APPROVER, reviewedDigest: DIGEST } },

  {
    name: "already approved by the viewer on this digest",
    viewer: APPROVER,
    approvals: [approval({ approver: { kind: "user", id: "user_other", name: "Dev" } })],
    decision: decision({ approval: { count: 2, minRole: "editor", separationOfDuties: true } }),
    reason: "already_decided",
    says: "already approved",
  },
  {
    name: "already rejected by the viewer on this digest",
    viewer: APPROVER,
    approvals: [approval({ decision: "reject", approver: { kind: "user", id: "user_other", name: "Dev" } })],
    reason: "already_decided",
    says: "already rejected",
  },
  {
    name: "an approval of an older digest does not block a new decision",
    viewer: APPROVER,
    approvals: [approval({ proposalDigest: DIGEST_2 })],
  },
  {
    name: "an expired earlier approval does not block a new decision",
    viewer: APPROVER,
    approvals: [approval({ expiresAt: EARLIER })],
  },

  {
    name: "enough approvals already recorded",
    viewer: { id: "user_third", role: "admin" },
    approvals: [approval({ approver: { kind: "user", id: "user_other", name: "Dev" } })],
    reason: "already_satisfied",
    says: "Enough approvals",
  },
  {
    name: "a second approver is still needed under a two-approver rule",
    viewer: { id: "user_third", role: "admin" },
    decision: decision({ approval: { count: 2, minRole: "editor", separationOfDuties: true } }),
    approvals: [approval({ approver: { kind: "user", id: "user_other", name: "Dev" } })],
  },
  {
    name: "an approval made under another policy version does not count",
    viewer: { id: "user_third", role: "admin" },
    approvals: [approval({ policyVersion: "b".repeat(64), approver: { kind: "user", id: "user_other", name: "Dev" } })],
  },

  { name: "no policy decision available", viewer: APPROVER, decision: undefined, reason: "policy_unavailable", says: "not available" },
  {
    name: "policy blocked the change",
    viewer: APPROVER,
    decision: decision({ outcome: "deny", approval: undefined }),
    reason: "policy_unavailable",
    says: "blocked",
  },
  {
    name: "policy allowed without approval",
    viewer: APPROVER,
    decision: decision({ outcome: "allow", approval: undefined }),
    reason: "policy_unavailable",
    says: "did not ask for an approval",
  },
  {
    name: "require_approval without a requirement fails closed",
    viewer: APPROVER,
    decision: decision({ approval: undefined }),
    reason: "policy_unavailable",
    says: "does not say who may approve",
  },
];

describe("approvalEligibility", () => {
  it.each(CASES)("$name", (c) => {
    const d = c.decision === undefined && "decision" in c ? undefined : (c.decision as PolicyDecisionRecord | undefined) ?? decision();
    const result = approvalEligibility(c.viewer, operation(c.op), d, c.approvals ?? [], c.now ?? NOW);
    if (c.reason === undefined) {
      expect(result).toEqual({ eligible: true });
    } else {
      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reason).toBe(c.reason);
        expect(result.message.length).toBeGreaterThan(20);
        // a reason is a sentence for a person, never a code
        expect(result.message).not.toMatch(/[a-z]+_[a-z_]+/);
        if (c.says) expect(result.message).toContain(c.says);
      }
    }
  });

  describe("which reason wins when several apply", () => {
    it("reports a non-awaiting status before an expired proposal", () => {
      const r = approvalEligibility(APPROVER, operation({ status: "approved", expiresAt: EARLIER }), decision(), [], NOW);
      expect(r).toMatchObject({ eligible: false, reason: "not_awaiting_approval" });
    });

    it("reports expiry before a moved digest", () => {
      const r = approvalEligibility({ ...APPROVER, reviewedDigest: DIGEST_2 }, operation({ expiresAt: EARLIER }), decision(), [], NOW);
      expect(r).toMatchObject({ eligible: false, reason: "expired" });
    });

    it("reports a moved digest before the viewer's role", () => {
      const r = approvalEligibility({ id: "user_v", role: "viewer", reviewedDigest: DIGEST_2 }, operation(), decision(), [], NOW);
      expect(r).toMatchObject({ eligible: false, reason: "digest_changed" });
    });

    it("reports a low role before the requester rule", () => {
      const r = approvalEligibility({ id: "user_requester", role: "viewer" }, operation(), decision(), [], NOW);
      expect(r).toMatchObject({ eligible: false, reason: "role_too_low" });
    });
  });

  it("uses the given clock, not the wall clock", () => {
    const op = operation({ expiresAt: "2026-09-30T12:30:00.000Z" });
    expect(approvalEligibility(APPROVER, op, decision(), [], "2026-09-30T12:29:59.000Z").eligible).toBe(true);
    expect(approvalEligibility(APPROVER, op, decision(), [], "2026-09-30T12:30:00.000Z")).toMatchObject({ reason: "expired" });
    expect(approvalEligibility(APPROVER, op, decision(), [], NOW_MS + 31 * 60_000)).toMatchObject({ reason: "expired" });
  });

  it("does not let approvals from another operation or workspace count", () => {
    const other = approval({ operationId: "op_other", approver: { kind: "user", id: "user_other", name: "Dev" } });
    expect(approvalEligibility(APPROVER, operation(), decision(), [other], NOW)).toEqual({ eligible: true });
  });
});

describe("approvalProgress", () => {
  it("counts distinct approvers whose approval is current", () => {
    const d = decision({ approval: { count: 3, minRole: "editor", separationOfDuties: true } });
    const a1 = approval({ id: "a1", approver: { kind: "user", id: "u1", name: "One" } });
    const dup = approval({ id: "a2", approver: { kind: "user", id: "u1", name: "One" } });
    const a2 = approval({ id: "a3", approver: { kind: "user", id: "u2", name: "Two" } });
    expect(approvalProgress(operation(), d, [a1, dup, a2], NOW)).toEqual({ required: 3, granted: 2 });
  });

  it("ignores stale digests, other policy versions, expired approvals and rejections", () => {
    const d = decision();
    const list = [
      approval({ id: "old", proposalDigest: DIGEST_2, approver: { kind: "user", id: "u1", name: "One" } }),
      approval({ id: "ver", policyVersion: "c".repeat(64), approver: { kind: "user", id: "u2", name: "Two" } }),
      approval({ id: "exp", expiresAt: EARLIER, approver: { kind: "user", id: "u3", name: "Three" } }),
      approval({ id: "rej", decision: "reject", approver: { kind: "user", id: "u4", name: "Four" } }),
    ];
    expect(approvalProgress(operation(), d, list, NOW).granted).toBe(0);
  });

  it("ignores approvals from a role below the minimum", () => {
    const d = decision({ approval: { count: 1, minRole: "admin", separationOfDuties: false } });
    const low = approval({ approverRole: "editor", approver: { kind: "user", id: "u1", name: "One" } });
    expect(approvalProgress(operation(), d, [low], NOW).granted).toBe(0);
  });

  it("reports no requirement when policy did not give one", () => {
    expect(approvalProgress(operation(), undefined, [], NOW)).toEqual({ required: undefined, granted: 0 });
  });

  it("keeps the policy version constant used by the fixtures honest", () => {
    expect(approval().policyVersion).toBe(POLICY_VERSION);
    expect(approval().expiresAt).toBe(LATER);
  });
});

describe("requesterId", () => {
  it("is the user for a person and the human behind an agent otherwise", () => {
    expect(requesterId(operation())).toBe("user_requester");
    expect(requesterId(operation({ principal: { kind: "integration", id: "i", name: "Agent", onBehalfOf: "user_owner" } }))).toBe("user_owner");
    expect(requesterId(operation({ principal: { kind: "system", id: "sys", name: "Reconciler" } }))).toBeUndefined();
  });
});
