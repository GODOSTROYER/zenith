/**
 * Day-two operations: restart and scale.
 *
 * Restart acts on a running environment, so it says which provider it is
 * talking to and whether that is real. Scale is a manifest edit — it changes
 * the working copy and costs money, so it goes through plan/deploy like
 * everything else.
 */
import { z } from "zod";
import { defineAction } from "@/lib/actions/core";
import { q } from "@/lib/db/store";
import { ServiceSize, type Environment } from "@/lib/domain/types";
import { providerRegistry } from "@/lib/providers/types";
import { SIZE_SPECS } from "@/lib/cost/pricing";
import { getEngine } from "./_engine";
import { clone, requireEnvironment, requireProject, requireService } from "./_shared";
import { manifestAction } from "./system";

/** Make sure provider adapters are registered before we ask about one. */
async function providerFor(env: Environment) {
  const conn = q.connection(env.connectionId);
  if (!conn)
    throw new Error(`${env.name} has no cloud connection. Reconnect one in Settings → Connections.`);
  if (!providerRegistry().has(conn.provider)) await getEngine();
  const adapter = providerRegistry().get(conn.provider);
  if (!adapter)
    throw new Error(`Provider "${conn.provider}" is not available in this build. Pick another connection for ${env.name}.`);
  return { adapter, conn };
}

/* ----------------------------- restartService ----------------------------- */

/**
 * Every restart is simulated, on every provider.
 *
 * `ProviderAdapter` has no restart method — the contract is plan/execute/
 * export — so there is no code path from this action to a running process on
 * any adapter. The sandbox is honest about that by construction; LocalStack
 * does not run your containers either (ECS is one of the kinds it simulates).
 * These two helpers make the result say which of those it was, rather than
 * reporting a success that touched nothing.
 */
function restartDetail(adapter: { id: string; displayName: string }): string {
  if (adapter.id === "sandbox")
    return "The sandbox marks the service restarting, then healthy again. No process exists to restart.";
  if (adapter.id === "localstack")
    return "LocalStack Community does not run your containers — ECS is one of the kinds it simulates — so no process was restarted.";
  return `${adapter.displayName} has no live restart in Orrery: no provider adapter implements one, so nothing was restarted.`;
}

function restartWarning(adapter: { id: string; displayName: string }): string {
  return adapter.id === "sandbox"
    ? "Simulated: nothing is provisioned in the sandbox, so nothing is restarted."
    : `Simulated: ${adapter.displayName} runs the deploy, but Orrery has no live restart for it. To replace the running copy, deploy the environment again.`;
}

const Restart = z.object({
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
  serviceId: z.string().min(1),
});
type Restart = z.infer<typeof Restart>;

defineAction<Restart>({
  id: "ops.restartService",
  title: "Restart service",
  category: "operations",
  risk: "medium",
  requiredRole: "editor",
  mutates: true,
  input: Restart,
  async plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const project = requireProject(ctx, input.projectId ?? env.projectId);
    const service = requireService(project.workingManifest, input.serviceId);
    const { adapter } = await providerFor(env);
    return {
      summary: `Restart ${service.name} in ${env.name} (simulated).`,
      details: [
        service.replicas > 1
          ? `${service.replicas} replicas would be replaced one at a time, so traffic keeps flowing.`
          : `${service.name} runs a single replica, so there would be a short gap while it comes back.`,
        `Through ${adapter.displayName} (${adapter.availability}).`,
        restartDetail(adapter),
        "Nothing about the system definition changes — no revision, no deployment.",
      ],
      costDeltaUsd: 0,
      risk: "low",
      warnings: [restartWarning(adapter)],
      requiresApproval: false,
    };
  },
  async execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const project = requireProject(ctx, input.projectId ?? env.projectId);
    const service = requireService(project.workingManifest, input.serviceId);
    const { adapter } = await providerFor(env);

    if (!env.deployedRevisionId)
      return {
        ok: false,
        summary: `${service.name} is not running in ${env.name}.`,
        error: `${env.name} has never been deployed. Deploy the system first, then restart it.`,
      };

    if (adapter.availability !== "available")
      return {
        ok: false,
        summary: `${adapter.displayName} cannot restart services yet.`,
        error: `${adapter.displayName} is ${adapter.availability} in Orrery: it plans and exports, but does not operate live infrastructure. Restart ${service.name} with your own tooling, or deploy this environment to the sandbox.`,
      };

    return {
      ok: true,
      summary: `Simulated restart of ${service.name} in ${env.name} (${service.replicas} replica${service.replicas === 1 ? "" : "s"}). ${restartDetail(adapter)}`,
      data: {
        serviceId: service.id,
        environmentId: env.id,
        replicas: service.replicas,
        // Always true: see restartDetail. Flip this the day an adapter grows a
        // real restart, and only for that adapter.
        simulated: true,
        provider: adapter.id,
        at: new Date().toISOString(),
      },
    };
  },
});

/* ------------------------------ scaleService ------------------------------ */

const Scale = z.object({
  projectId: z.string().optional(),
  serviceId: z.string().min(1),
  replicas: z.number().int().min(0).max(10).optional(),
  size: ServiceSize.optional(),
});
type Scale = z.infer<typeof Scale>;

manifestAction<Scale>({
  id: "ops.scaleService",
  title: "Scale service",
  risk: "low",
  input: Scale,
  build(project, input) {
    if (input.replicas === undefined && !input.size)
      throw new Error("Say what to change: pass replicas, size, or both.");
    const next = clone(project.workingManifest);
    const service = requireService(next, input.serviceId);
    const from = `${service.replicas}× ${service.size}`;
    if (input.replicas !== undefined) service.replicas = input.replicas;
    if (input.size) service.size = input.size;
    const spec = SIZE_SPECS[service.size];

    const warnings: string[] = [];
    if (service.replicas === 0)
      warnings.push(`${service.name} stops serving traffic at 0 replicas once this is deployed.`);
    if (service.kind === "cron" && input.replicas !== undefined)
      warnings.push(`${service.name} is a scheduled job — replicas do not change how often it runs.`);

    return {
      next,
      what: `Scales ${service.name} from ${from} to ${service.replicas}× ${service.size}`,
      details: [`Each replica gets ${spec.vcpu} vCPU and ${spec.memoryMb} MB.`],
      warnings,
      data: { serviceId: service.id, replicas: service.replicas, size: service.size },
    };
  },
});
