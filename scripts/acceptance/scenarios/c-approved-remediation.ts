/**
 * Demo C — approved remediation. Continuing from Demo B's broken database
 * security group: Zenith proposes the repair, a human approves the exact
 * proposal (or policy allows it), Zenith executes it, and the harness checks
 * from outside that the rule is back exactly as it was and /db works again.
 *
 * The capability used is `drift.repair`: the removed rule is part of the
 * environment's desired state, so putting it back is repairing drift. (The
 * input shape the executor expects was unmerged when this was written; the
 * request carries the firewall address and is read defensively.)
 *
 * Status: executable, never run (see `blockedOn`).
 */
import { awsOf, type PassCriterion, type ScenarioDefinition } from "../types";
import { awaitApproval, awaitTerminal, checker, controlPlaneReachable, cp, dependsOnEarlier, liveControlPlaneConfig, awsTargetConfig } from "./_shared";
import { currentPortRules, ruleSignature, type DbSecurityGroup } from "./_aws";

const CRITERIA: readonly PassCriterion[] = [
  { id: "proposed", text: "Zenith's repair is a proposal (an operation with a digest and a stated risk) before it is anything else." },
  { id: "approval", text: "If policy required approval, a human other than the proposer approved the exact proposal before execution; if policy allowed it unattended this is skipped, not passed." },
  { id: "executed", text: "The repair operation reaches succeeded." },
  { id: "rule-restored", text: "The security group's tcp/5432 rules are exactly the set recorded before Demo B broke them (nothing broader was opened)." },
  { id: "recovered", text: "/db reports the database reachable again within five minutes." },
];

const C = checker("C", CRITERIA);
const S = "C";

export const demoC: ScenarioDefinition = {
  id: "C",
  title: "Approved remediation",
  summary: "Repair the database security group through a proposal, an approval and an execution, then verify from outside that the rule is restored exactly and the app recovers.",
  needs: { cloud: "aws", controlPlane: true, temporal: true },
  mutates: true,
  createsResources: false,
  dependsOn: ["A", "B"],
  prerequisites: [awsTargetConfig, liveControlPlaneConfig, controlPlaneReachable, dependsOnEarlier("B")],
  steps: [
    {
      id: "propose",
      title: "Propose the repair (drift.repair on the database firewall)",
      effect: "mutate",
      plan: () => ["propose capability drift.repair with the database firewall's address", "record the decision; if approval is required, wait for a person (the harness cannot approve)"],
      async run(ctx) {
        const scope = { workspaceId: ctx.config.workspaceId!, projectId: ctx.state.get("a.projectId") as string, environmentId: ctx.state.get("a.environmentId") as string, resourceId: "firewall/web-to-db" };
        const proposed = await cp(ctx).proposeCapability({ capability: "drift.repair", scope, input: { address: "firewall/web-to-db" }, reason: `live acceptance ${ctx.runId}: restore the database ingress rule`, idempotencyKey: `${ctx.runId}-repair` });
        ctx.state.set("c.op", proposed.operation.id);
        ctx.evidence.operation(S, { operationId: proposed.operation.id, capability: "drift.repair", status: proposed.operation.status, detail: `decision ${proposed.decision.outcome}` });
        C.expect(ctx, "proposed", proposed.decision.outcome !== "deny" && !!proposed.operation.proposalDigest && !!proposed.decision.risk, `decision ${proposed.decision.outcome}, risk ${proposed.decision.risk ?? "none stated"}, digest ${String(proposed.operation.proposalDigest ?? "none").slice(0, 12)}.`);
        const outcome = await awaitApproval(ctx, proposed);
        if (outcome.mode === "human") C.expect(ctx, "approval", outcome.approverIsHuman, `approved by a person after ${Math.round(outcome.waitedMs / 1000)} s.`);
        else C.skip(ctx, "approval", `policy allowed the repair unattended (autonomy ${proposed.decision.environment?.autonomyLevel ?? "unknown"}); the approval path was not exercised`);
      },
    },
    {
      id: "execute",
      title: "Wait for the repair to execute",
      effect: "read",
      plan: () => ["poll the operation until terminal (up to 20 minutes)"],
      async run(ctx) {
        const op = await awaitTerminal(ctx, S, ctx.state.get("c.op") as string, 20 * 60_000);
        C.expect(ctx, "executed", op.status === "succeeded", `repair operation ${op.status}${op.error ? `: ${op.error}` : ""}.`);
        if (op.status !== "succeeded") throw new Error(`The repair ended ${op.status}.`);
      },
    },
    {
      id: "verify",
      title: "Verify the rule is restored exactly and /db recovers",
      effect: "read",
      plan: () => ["DescribeSecurityGroups and compare the tcp/5432 rules with the set recorded before the break", "poll GET <url>/db for up to 5 minutes"],
      async run(ctx) {
        const sg = ctx.state.get("b.sg") as DbSecurityGroup;
        const now = ruleSignature(await currentPortRules(ctx, sg.groupId));
        const original = ctx.state.get("b.originalSignature") as string;
        C.expect(ctx, "rule-restored", now === original, now === original ? "the rule set equals the pre-break set." : `rules differ: expected ${original}, found ${now}.`);
        const url = ctx.state.get("a.url") as string;
        const up = await ctx.probe.waitFor(new URL("/db", url).href, { accept: (r) => r.status === 200, timeoutMs: 5 * 60_000, intervalMs: 10_000, requestTimeoutMs: 15_000 });
        ctx.evidence.httpProbe(S, { label: "db-recovered", url: up.last.url, status: up.last.status, ok: up.accepted, error: up.last.error, bodySnippet: up.last.bodySnippet });
        C.expect(ctx, "recovered", up.accepted, `/db ${up.last.status ?? up.last.error} after ${up.attempts} attempt(s).`);
        void awsOf(ctx);
      },
    },
  ],
  passCriteria: CRITERIA,
  proves: [
    "A repair goes through the same propose, approve, execute path as any change, and its effect is exactly the intended one, observed from outside Zenith.",
  ],
  cannotProve: [
    "That Zenith chose the repair by itself: the harness names the capability and the target; the incident engine's own remediation options are not exercised here.",
    "That an approval could not have been bypassed: when policy allows the repair unattended, no approval happens and the criterion is skipped.",
    "That the repair is safe for causes other than this one rule.",
  ],
  blockedOn: [
    "Needs Demos A and B to have run in a real sandbox account.",
    "The drift.repair executor's input shape and the incident remediation workflow were in unmerged workstreams.",
  ],
  runsLocally: false,
  costNote: "no new billable resources",
};
