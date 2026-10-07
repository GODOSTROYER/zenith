/**
 * Shared steps of the planning-side activities: the executable desired state
 * for an operation, the lease an activity was handed, the tofu session view of a
 * provider session, and the cost delta of a plan.
 */
import type { ProviderSession } from "@/lib/credentials/types";
import type { ResourceGraph } from "@/lib/resources/types";
import type { TofuSessionEnv } from "@/lib/tofu/runner";
import type { LeaseRef } from "@/lib/workflows/types";
import type { ExecContext, ExecLike } from "./context";
import { StepFailedError } from "./errors";
import { buildDesiredState, findGraphProblems } from "./graph";
import type { PlanCost } from "./plan-evidence";
import type { Runtime } from "./runtime";
import { inputEnvName } from "./typed-inputs";
import { errorText } from "./text";

/** The graph this operation will execute, or a definitive failure naming why it cannot. */
export function requireExecutable(rt: Runtime, ec: Pick<ExecLike, "product">): { graph: ResourceGraph } {
  const desired = buildDesiredState(ec.product);
  const problems = desired.graph ? findGraphProblems(desired.graph, ec.product.environment.provider, rt.drivers) : desired.problems;
  if (!desired.graph || problems.length > 0) {
    const shown = problems.slice(0, 3).join("; ");
    throw new StepFailedError(`The desired state is not executable: ${shown}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}`);
  }
  return { graph: desired.graph };
}

/**
 * A lease handed to an activity must be this operation's environment lease,
 * taken by a worker for this operation. The store's fence check proves the
 * lease is LIVE; this proves it is the right one.
 */
export function assertLeaseFor(ec: Pick<ExecContext, "op" | "environmentId">, lease: LeaseRef): void {
  if (lease.scope !== `env:${ec.environmentId}`) throw new StepFailedError("The lease does not belong to this operation's environment; refusing to act under it.");
  if (!lease.holder.startsWith("worker:") || !lease.holder.endsWith(`:${ec.op.id}`)) throw new StepFailedError("The lease was not taken for this operation; refusing to act under it.");
}

/** What `planWorkspace` / `applyVerifiedPlan` take from a provider session: only `childProcessEnv()`. */
export function tofuSession(session: ProviderSession): TofuSessionEnv {
  return "childProcessEnv" in session ? session : {};
}

/**
 * The tofu session of an operation that may consume typed inputs. Without secret inputs it is exactly `tofuSession(session)`.
 * With them, each secret is read from the vault NOW, under this operation's own workspace and only if it is one of this
 * operation's declared inputs, and offered on the dedicated `inputEnv` channel: the values reach only the tofu child's
 * environment (as `TF_VAR_zenith_in_*`), are redacted, and are held by this closure only for the life of the activity.
 */
export async function tofuSessionFor(rt: Pick<Runtime, "d">, ec: Pick<ExecContext, "workspaceId" | "op" | "typedInputs">, session: ProviderSession): Promise<TofuSessionEnv> {
  const base = tofuSession(session);
  const secrets = (ec.typedInputs ?? []).filter((input) => input.secret !== undefined);
  if (!secrets.length) return base;
  if (!rt.d.typedInputs) throw new StepFailedError("This operation consumes secret inputs but no typed-input custody is configured; refusing to run it.");
  const env: Record<string, string> = {};
  for (const input of secrets) env[inputEnvName(input.name)] = await rt.d.typedInputs.resolveSecret(ec.workspaceId, ec.op.id, input.secret!.ref);
  return {
    ...(base.provider ? { provider: base.provider } : {}),
    ...(base.childProcessEnv ? { childProcessEnv: () => base.childProcessEnv!.call(base) } : {}),
    inputEnv: () => ({ ...env }),
  };
}

/**
 * Estimated monthly cost change of this plan: the cost of the desired graph
 * minus the cost of the graph of the environment's currently deployed revision
 * (zero for a first deploy; zero for a redeploy of the same revision). It is a
 * difference of two catalog ESTIMATES, not a bill, and it is absent (never zero)
 * whenever either estimate is unavailable.
 */
export async function costOf(rt: Runtime, ec: Pick<ExecLike, "product" | "workspaceId" | "environmentId">, graph: ResourceGraph): Promise<PlanCost> {
  const cost = rt.cost;
  try {
    const next = await cost.estimate(graph);
    if (!next) return {};
    const out: PlanCost = { projectedMonthlyUsd: next.monthlyUsd, catalogVersion: next.catalogVersion };
    const deployedId = ec.product.environment.deployedRevisionId;
    if (!deployedId) return { ...out, deltaUsdMonthly: next.monthlyUsd };
    if (deployedId === ec.product.revision?.id) return { ...out, deltaUsdMonthly: 0 };
    const previous = await rt.d.product.loadRevision({ workspaceId: ec.workspaceId, environmentId: ec.environmentId, revisionId: deployedId });
    if (!previous) return out;
    const before = buildDesiredState({ ...ec.product, revision: previous });
    if (!before.graph) return out;
    const prior = await cost.estimate(before.graph);
    return prior ? { ...out, deltaUsdMonthly: Math.round((next.monthlyUsd - prior.monthlyUsd) * 100) / 100 } : out;
  } catch (err) {
    rt.log("warn", "cost estimate failed; the plan carries no cost delta", { error: errorText(err) });
    return {};
  }
}
