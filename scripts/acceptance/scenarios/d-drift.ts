/**
 * Demo D — drift. Change something in the account behind Zenith's back (an ECS
 * service's desired count, the way an autoscaler or a person with console
 * access would), then check that Zenith's drift detection sees it, reports it
 * honestly, and does not "repair" it on its own.
 *
 * The change is made by the harness with the operator's sandbox credentials
 * after `guardedChange` has confirmed the service carries THIS run's tag, and is
 * put back afterwards.
 *
 * The drift route can answer with SIMULATED data (the sandbox provider does).
 * A response with `simulated: true` is never counted as live evidence: the
 * detection criterion fails with that reason instead of passing.
 *
 * Status: executable, never run (see `blockedOn`).
 */
import { DescribeServicesCommand, ECSClient, UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { awsOf, type PassCriterion, type ScenarioDefinition } from "../types";
import { checker, controlPlaneReachable, cp, dependsOnEarlier, liveControlPlaneConfig, awsTargetConfig } from "./_shared";
import { guardedChange, runResourcesOfType } from "./_aws";

const CRITERIA: readonly PassCriterion[] = [
  { id: "baseline", text: "Before the change, the control plane's drift report for the environment is real (not simulated) and shows no finding for the service." },
  { id: "detected", text: "After an out-of-band change to the service's desired count, a real (not simulated) drift report names the service and the changed attribute within ten minutes." },
  { id: "not-auto-repaired", text: "Zenith did not repair the drift by itself: the service's desired count is still the changed value after the detection window." },
];

const C = checker("D", CRITERIA);
const S = "D";

interface Target {
  arn: string;
  cluster: string;
  service: string;
  original: number;
}

/** True when a drift response is flagged simulated at the top level. */
const isSimulated = (r: Record<string, unknown>): boolean => r.simulated === true;

const mentions = (r: Record<string, unknown>, name: string): boolean => JSON.stringify(r.items ?? r.findings ?? r).includes(name);

export const demoD: ScenarioDefinition = {
  id: "D",
  title: "Drift (external modification and detection)",
  summary: "Change an ECS service's desired count out of band and check Zenith's drift detection reports it truthfully and leaves it alone.",
  needs: { cloud: "aws", controlPlane: true, temporal: false },
  mutates: true,
  createsResources: false,
  dependsOn: ["A"],
  prerequisites: [awsTargetConfig, liveControlPlaneConfig, controlPlaneReachable, dependsOnEarlier("A")],
  steps: [
    {
      id: "baseline",
      title: "Find the run's ECS service and read the baseline drift report",
      effect: "read",
      plan: () => ["find the run's ECS service through the tagging API", "GET /api/environments/<id>/drift; refuse to treat a simulated report as live evidence"],
      async run(ctx) {
        const arns = await runResourcesOfType(ctx, "ecs:service");
        if (arns.length !== 1) throw new Error(`Expected exactly one run-tagged ECS service, found ${arns.length}.`);
        const arn = arns[0]!;
        const [, , , , , resource] = arn.split(":");
        const parts = resource!.split("/");
        const cluster = parts[1]!;
        const service = parts[2]!;
        const ecs = awsOf(ctx).client(ECSClient);
        const original = (await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }))).services?.[0]?.desiredCount;
        if (original === undefined) throw new Error("Could not read the service's desired count.");
        ctx.state.set("d.target", { arn, cluster, service, original } satisfies Target);
        const drift = await cp(ctx).getDrift(ctx.state.get("a.environmentId") as string);
        if (isSimulated(drift)) {
          C.fail(ctx, "baseline", "the drift route answered with simulated data, which is not live evidence");
          throw new Error("The drift report is simulated; the control plane is not observing the real account.");
        }
        C.expect(ctx, "baseline", !mentions(drift, service), `real drift report, no finding mentions ${service}.`);
      },
    },
    {
      id: "modify",
      title: "Change the service's desired count out of band",
      effect: "mutate",
      plan: () => ["re-read the service's tags and refuse unless it carries this run's zenith:live-run tag", "UpdateService desiredCount = original + 1"],
      async run(ctx) {
        const t = ctx.state.get("d.target") as Target;
        await guardedChange(ctx, t.arn, () => awsOf(ctx).client(ECSClient).send(new UpdateServiceCommand({ cluster: t.cluster, service: t.service, desiredCount: t.original + 1 })));
        ctx.evidence.note(`Changed ${t.service} desiredCount ${t.original} -> ${t.original + 1} out of band.`, S);
      },
    },
    {
      id: "detect",
      title: "Wait for Zenith to report the drift; confirm it did not repair it",
      effect: "read",
      plan: () => ["poll GET /api/environments/<id>/drift for up to 10 minutes until a real report names the service", "then wait two more minutes and confirm the desired count is still the changed value"],
      async run(ctx) {
        const t = ctx.state.get("d.target") as Target;
        const envId = ctx.state.get("a.environmentId") as string;
        const deadline = ctx.now().getTime() + 10 * 60_000;
        let sawSimulated = false;
        let found = false;
        for (;;) {
          const drift = await cp(ctx).getDrift(envId);
          if (isSimulated(drift)) sawSimulated = true;
          else if (mentions(drift, t.service)) {
            found = true;
            ctx.evidence.logQuery(S, { source: "zenith.drift", query: "GET drift", lines: [JSON.stringify(drift).slice(0, 4000)] });
            break;
          }
          if (ctx.now().getTime() > deadline) break;
          await ctx.sleep(15_000);
        }
        C.expect(ctx, "detected", found, found ? `a real drift report names ${t.service}.` : sawSimulated ? "the drift route only ever answered with simulated data" : "no drift report named the service within ten minutes");
        await ctx.sleep(2 * 60_000);
        const count = (await awsOf(ctx).client(ECSClient).send(new DescribeServicesCommand({ cluster: t.cluster, services: [t.service] }))).services?.[0]?.desiredCount;
        C.expect(ctx, "not-auto-repaired", count === t.original + 1, `desired count is ${count} (changed value ${t.original + 1}, original ${t.original}).`);
      },
    },
    {
      id: "restore",
      title: "Put the desired count back",
      effect: "mutate",
      plan: () => ["re-check the run tag, then UpdateService desiredCount = the original"],
      async run(ctx) {
        const t = ctx.state.get("d.target") as Target;
        await guardedChange(ctx, t.arn, () => awsOf(ctx).client(ECSClient).send(new UpdateServiceCommand({ cluster: t.cluster, service: t.service, desiredCount: t.original })));
      },
    },
  ],
  passCriteria: CRITERIA,
  proves: [
    "Zenith's drift detection reads the real account (not a simulation) and reports an out-of-band change to a managed resource.",
    "Medium-risk drift is reported, not silently overwritten.",
  ],
  cannotProve: [
    "That detection is timely under load or for every attribute: one attribute of one resource type is changed once.",
    "That Zenith never auto-repairs: the window is two minutes, and only an environment with auto-repair enabled would act.",
    "Anything about drift in resources the harness did not change.",
  ],
  blockedOn: [
    "Needs Demo A to have deployed to a real sandbox account.",
    "The product's drift route reports simulated data for providers without a real observer; the platform reconciler and AWS drivers were in unmerged workstreams.",
  ],
  runsLocally: false,
  costNote: "one extra Fargate task for a few minutes (cents)",
};
