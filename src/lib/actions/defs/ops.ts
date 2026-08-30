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
    const simulated = adapter.availability !== "available" || adapter.id === "sandbox";
    return {
      summary: `Restart ${service.name} in ${env.name}${adapter.id === "sandbox" ? " (simulated)" : ""}.`,
      details: [
        service.replicas > 1
          ? `${service.replicas} replicas are replaced one at a time, so traffic keeps flowing.`
          : `${service.name} runs a single replica, so there is a short gap while it comes back.`,
        `Through ${adapter.displayName} (${adapter.availability}).`,
        adapter.id === "sandbox"
          ? "The sandbox simulates the restart: the service is marked restarting, then healthy again. No real process is touched."
          : "This acts on the running environment.",
        "Nothing about the system definition changes — no revision, no deployment.",
      ],
      costDeltaUsd: 0,
      risk: service.replicas > 1 ? "low" : "medium",
      warnings: simulated && adapter.id !== "sandbox"
        ? [`${adapter.displayName} is ${adapter.availability}; restarts are not executed against real infrastructure yet.`]
        : [],
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
      summary:
        adapter.id === "sandbox"
          ? `Rolling restart of ${service.name} in ${env.name} — sandbox restart (simulated), ${service.replicas} replica${service.replicas === 1 ? "" : "s"}.`
          : `Rolling restart of ${service.name} in ${env.name} (${service.replicas} replica${service.replicas === 1 ? "" : "s"}).`,
      data: {
        serviceId: service.id,
        environmentId: env.id,
        replicas: service.replicas,
        simulated: adapter.id === "sandbox",
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
