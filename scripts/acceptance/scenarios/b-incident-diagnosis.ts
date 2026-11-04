/**
 * Demo B — incident diagnosis. Break the app-to-database path the way a person
 * (or a bad change) would — remove the database security group's ingress rule —
 * and check that Zenith's investigation finds it, without changing anything.
 *
 * The break is done out of band by the harness with the operator's sandbox
 * credentials, after `guardedChange` has re-read the security group's tags and
 * confirmed it carries THIS run's tag. The sample app's /health keeps answering
 * 200 on purpose (it never touches the database), so the outage is invisible to
 * a load balancer and has to be diagnosed: only /db and the app's own log lines
 * (`db_connect_failed ... reason: timeout`) show it.
 *
 * Leaves the rule removed for Demo C. If C does not run, cleanup deletes the
 * whole run anyway; the removed rule is recorded in the evidence.
 *
 * Status: executable, never run (see `blockedOn`).
 */
import { RevokeSecurityGroupIngressCommand, EC2Client } from "@aws-sdk/client-ec2";
import { awsOf, type PassCriterion, type ScenarioDefinition } from "../types";
import { checker, controlPlaneReachable, cp, dependsOnEarlier, liveControlPlaneConfig, awsTargetConfig } from "./_shared";
import { currentPortRules, findDbSecurityGroup, guardedChange, recentEnvironmentLogs, ruleSignature, type DbSecurityGroup } from "./_aws";
import { awaitTerminal } from "./_shared";

const CRITERIA: readonly PassCriterion[] = [
  { id: "baseline", text: "Before the break, /db reports the database reachable (the path worked, so the change is what broke it)." },
  { id: "symptom", text: "After the rule is removed, /db fails with a timeout while /health still answers 200 (the outage is invisible to the load balancer)." },
  { id: "logs-show-it", text: "The application's own logs contain a db_connect_failed line with reason timeout after the break." },
  { id: "diagnosis", text: "Zenith's investigation names the database security group (its id) or the tcp/5432 ingress rule as the cause, with evidence." },
  { id: "read-only", text: "The investigation changed nothing: the security group's port rules are still the broken set afterwards." },
];

const C = checker("B", CRITERIA);
const S = "B";

export const demoB: ScenarioDefinition = {
  id: "B",
  title: "Incident diagnosis (database security group broken)",
  summary: "Remove the database security group's ingress rule out of band, then check Zenith's investigation finds it and changes nothing.",
  needs: { cloud: "aws", controlPlane: true, temporal: false },
  mutates: true,
  createsResources: false,
  dependsOn: ["A"],
  prerequisites: [awsTargetConfig, liveControlPlaneConfig, controlPlaneReachable, dependsOnEarlier("A")],
  steps: [
    {
      id: "baseline",
      title: "Confirm /db works and find the database security group",
      effect: "read",
      plan: () => ["GET <url>/db and expect reachable", "find the run's security group that allows tcp/5432 (tagging API + DescribeSecurityGroups) and keep its rules"],
      async run(ctx) {
        const url = ctx.state.get("a.url") as string;
        const db = await ctx.probe.get(new URL("/db", url).href, { timeoutMs: 15_000, expect: () => true });
        ctx.evidence.httpProbe(S, { label: "db-baseline", url: db.url, status: db.status, ok: db.status === 200, error: db.error, bodySnippet: db.bodySnippet });
        C.expect(ctx, "baseline", db.status === 200, `status ${db.status ?? db.error}.`);
        const sg = await findDbSecurityGroup(ctx);
        ctx.state.set("b.sg", sg);
        ctx.state.set("b.originalSignature", ruleSignature(sg.dbRules));
        return { detail: `database security group ${sg.groupId} with ${sg.dbRules.length} rule(s) on tcp/5432` };
      },
    },
    {
      id: "break",
      title: "Remove the tcp/5432 ingress rule (out of band, run-tagged group only)",
      effect: "mutate",
      plan: () => ["re-read the security group's tags and refuse unless it carries this run's zenith:live-run tag", "RevokeSecurityGroupIngress for exactly the tcp/5432 rules recorded in the previous step"],
      async run(ctx) {
        const sg = ctx.state.get("b.sg") as DbSecurityGroup;
        await guardedChange(ctx, sg.arn, () => awsOf(ctx).client(EC2Client).send(new RevokeSecurityGroupIngressCommand({ GroupId: sg.groupId, IpPermissions: sg.dbRules })));
        ctx.evidence.note(`Removed ${sg.dbRules.length} tcp/5432 ingress rule(s) from ${sg.groupId}: ${ruleSignature(sg.dbRules)}`, S);
        ctx.state.set("b.brokenAt", ctx.now().toISOString());
      },
    },
    {
      id: "symptom",
      title: "Observe the symptom: /db times out, /health stays 200",
      effect: "read",
      plan: () => ["poll GET <url>/db until it fails (up to 5 minutes)", "GET <url>/health and expect 200", "read the app's logs for db_connect_failed"],
      async run(ctx) {
        const url = ctx.state.get("a.url") as string;
        const failed = await ctx.probe.waitFor(new URL("/db", url).href, { accept: (r) => r.status === 503 || r.ok === false, timeoutMs: 5 * 60_000, intervalMs: 10_000, requestTimeoutMs: 15_000 });
        ctx.evidence.httpProbe(S, { label: "db-after-break", url: failed.last.url, status: failed.last.status, ok: false, error: failed.last.error, bodySnippet: failed.last.bodySnippet });
        const health = await ctx.probe.get(new URL("/health", url).href);
        ctx.evidence.httpProbe(S, { label: "health-after-break", url: health.url, status: health.status, ok: health.ok, error: health.error });
        C.expect(ctx, "symptom", failed.accepted && /timeout/.test(failed.last.bodySnippet ?? failed.last.error ?? "") && health.status === 200, `/db: ${failed.last.status ?? failed.last.error} ${failed.last.bodySnippet ?? ""}; /health: ${health.status}.`);
        const { lines } = await recentEnvironmentLogs(ctx, ctx.state.get("a.environmentId") as string, { sinceMs: 15 * 60_000, filter: "db_connect_failed" });
        ctx.evidence.logQuery(S, { source: "aws.cloudwatch-logs", query: "db_connect_failed", lines });
        C.expect(ctx, "logs-show-it", lines.some((l) => /"reason"\s*:\s*"timeout"/.test(l)), `${lines.length} db_connect_failed line(s).`);
      },
    },
    {
      id: "investigate",
      title: "Ask Zenith to investigate (incident.investigate)",
      effect: "mutate",
      plan: () => ["propose capability incident.investigate for the environment (read-only by catalog)", "wait for the result; look for the security group id or tcp/5432 in the findings", "re-read the security group's port rules and require them unchanged"],
      async run(ctx) {
        const sg = ctx.state.get("b.sg") as DbSecurityGroup;
        const scope = { workspaceId: ctx.config.workspaceId!, projectId: ctx.state.get("a.projectId") as string, environmentId: ctx.state.get("a.environmentId") as string };
        const proposed = await cp(ctx).proposeCapability({ capability: "incident.investigate", scope, input: { symptom: "The application's /db route times out while /health is healthy." }, reason: `live acceptance ${ctx.runId}: diagnose`, idempotencyKey: `${ctx.runId}-investigate` });
        if (proposed.decision.outcome !== "allow") throw new Error(`Investigation was not allowed unattended (${proposed.decision.outcome}); it is read-only and should be.`);
        const op = await awaitTerminal(ctx, S, proposed.operation.id, 15 * 60_000);
        const text = JSON.stringify(op.result ?? {});
        ctx.evidence.logQuery(S, { source: "zenith.incident.investigate", query: "result", lines: [text.slice(0, 4000)] });
        const named = text.includes(sg.groupId) || (/security.?group/i.test(text) && /5432/.test(text));
        C.expect(ctx, "diagnosis", op.status === "succeeded" && named, op.status === "succeeded" ? (named ? `the result names ${text.includes(sg.groupId) ? sg.groupId : "the security group and port 5432"}.` : "the investigation finished but did not name the security group or port.") : `investigation ${op.status}.`);
        const after = ruleSignature(await currentPortRules(ctx, sg.groupId));
        C.expect(ctx, "read-only", after === ruleSignature([]), after === ruleSignature([]) ? "the security group still has no tcp/5432 rule: nothing was changed." : `the security group's rules changed during the investigation: ${after}`);
      },
    },
  ],
  passCriteria: CRITERIA,
  proves: [
    "Zenith's investigation can find a real, out-of-band security-group change in a real account from symptoms and cloud state, without being told the cause.",
    "An investigation is read-only in practice, not just in the catalog.",
  ],
  cannotProve: [
    "That diagnosis works for causes other than this one security-group rule.",
    "That the diagnosis is reached by evidence rather than by luck: one run, one cause; a keyword match on the result is a weak test and the full result is in the evidence for a person to read.",
    "That the investigation never hallucinates: the result text is data to read, not something the harness can grade for truth beyond naming the right resource.",
  ],
  blockedOn: [
    "Needs Demo A to have deployed the environment in a real sandbox account (see A).",
    "The incident engine and the incident.investigate executor were in unmerged workstreams; the result shape is read defensively.",
  ],
  runsLocally: false,
  costNote: "adds nothing to Demo A's resources; the break and the investigation cost nothing",
};
