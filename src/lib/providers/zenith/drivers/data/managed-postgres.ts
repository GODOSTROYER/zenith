/**
 * `postgres` on the managed platform: a managed database service, NEVER an
 * in-cluster StatefulSet.
 *
 * The contract table maps `postgres` (and `mysql`, `redis`) to
 * `k8s:StatefulSet` for the `zenith` provider, because that row was copied from
 * Kubernetes. This driver is registered under that string so expansion's nodes
 * find a driver, but it never renders, observes or creates a StatefulSet: it
 * talks to the `ManagedDatabaseProvider` port. `mysql` and `redis` nodes that
 * reach it are answered `unsupported`, never treated as postgres. (Contract
 * change requested in the handoff: give `zenith` its own native types so the
 * `k8s:StatefulSet` string stops implying an in-cluster database.)
 *
 * Declarative lifecycle is `applyZenithEnvironment` (create-or-converge via the
 * port, then the vault holds the connection URI). This driver is the read side:
 *   observe   `port.get` → engine version, region, provider, the connection
 *             secret REFERENCE. Never a URI, host, role or password.
 *   runtime   from the provider's compute endpoint state: active and idle
 *             (scale-to-zero) are healthy, init is degraded, none or disabled is
 *             unhealthy, anything unread is unknown. Connectivity is never probed.
 *   verify    exists, engine version matches, compute is running or scaled to
 *             zero; credentials and connectivity are not probed here.
 *
 * Unavailable provider → presence `unknown`, every attribute `unknown`, and the
 * reason in the error, never a fabricated "missing".
 */
import type { ResourceDriver } from "@/lib/drivers/types";
import type { ObservedValue, ResourceNode } from "@/lib/resources/types";
import { databaseSpecFromNode, type DatabaseError } from "../../database";
import { isRecord } from "../../k8s-port";
import { assertSessionMatches, type ZenithSession } from "../../session";
import { contractEvidence, known, observation, runtimeState, unknownValue, verifyAgainst } from "../common";

export const MANAGED_POSTGRES_DRIVER_ID = "zenith.managed_postgres@1";

const ATTRS = ["managedByZenith", "engineVersion", "computeState"] as const;

function majorOf(node: ResourceNode): number | undefined {
  const v = isRecord(node.spec) && typeof node.spec.version === "string" ? node.spec.version : "16";
  const m = /^(\d{1,2})(\.\d{1,2})?$/.exec(v);
  return m ? Number(m[1]) : undefined;
}

const presenceOf = (e: DatabaseError): "inaccessible" | "unknown" => (e.code === "unauthorized" || e.code === "forbidden" ? "inaccessible" : "unknown");

export function createManagedPostgresDriver(nativeType: string): ResourceDriver<ZenithSession> {
  const id = MANAGED_POSTGRES_DRIVER_ID;

  return {
    id,
    provider: "zenith",
    kind: "postgres",
    nativeType,
    capabilities: {
      compile: false,
      observe: true,
      runtime: true,
      verify: true,
      discover: false,
      operations: [],
      evidence: contractEvidence(["observe", "runtime", "verify"]),
    },

    async observe(ctx, node, externalId) {
      assertSessionMatches(ctx.session, ctx);
      if (node.kind !== "postgres") {
        const attrs = Object.fromEntries(ATTRS.map((a) => [a, unknownValue("not_supported", `${node.kind} is not offered on the managed platform`)]));
        return observation({ ctx, node, source: id, presence: "unknown", attributes: attrs, error: `${node.kind} is not offered on the managed platform; only managed Postgres is.` });
      }
      const made = databaseSpecFromNode(ctx.session.tenant, { address: node.address, spec: isRecord(node.spec) ? node.spec : {} });
      if ("error" in made) return observation({ ctx, node, source: id, presence: "unknown", error: made.error });
      const r = await ctx.session.databases.get(
        { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, address: node.address, ...(externalId ? { externalId } : {}) },
        { signal: ctx.signal }
      );
      if (!r.ok) {
        const attrs = Object.fromEntries(ATTRS.map((a) => [a, unknownValue(r.error.code === "unauthorized" || r.error.code === "forbidden" ? "access_denied" : "error", r.error.message)]));
        return observation({ ctx, node, source: id, presence: presenceOf(r.error), attributes: attrs, error: `${r.error.code}: ${r.error.message}` });
      }
      if (r.value === null) return observation({ ctx, node, source: id, presence: "missing" });
      const now = ctx.now();
      const info = r.value;
      const attributes: Record<string, ObservedValue> = {
        managedByZenith: known(true, now),
        engineVersion: known(info.engineVersion, now),
        computeState: info.computeState ? known(info.computeState, now) : unknownValue("not_inspected"),
      };
      return observation({
        ctx,
        node,
        source: id,
        presence: "present",
        externalId: info.externalId,
        attributes,
        // a reference and non-secret facts only: no URI, host, role or password is ever read into an observation
        native: { provider: info.provider, regionId: info.regionId, projectName: info.name, connectionSecretRef: info.connectionSecretRef, settings: info.settings },
      });
    },

    async runtime(ctx, node, externalId) {
      assertSessionMatches(ctx.session, ctx);
      if (node.kind !== "postgres") return runtimeState(ctx, node, id, { signals: ["kind_not_offered"] });
      const r = await ctx.session.databases.get(
        { workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, address: node.address, ...(externalId ? { externalId } : {}) },
        { signal: ctx.signal }
      );
      if (!r.ok) return runtimeState(ctx, node, id, { signals: [`provider_${r.error.code}`] });
      if (r.value === null) return runtimeState(ctx, node, id, { health: "unhealthy", signals: ["provider_project_missing"] });
      switch (r.value.computeState) {
        case "active":
          return runtimeState(ctx, node, id, { health: "healthy", signals: ["compute_active", "connectivity_not_probed"] });
        case "idle":
          return runtimeState(ctx, node, id, { health: "healthy", signals: ["compute_idle_scale_to_zero", "connectivity_not_probed"] });
        case "init":
          return runtimeState(ctx, node, id, { health: "degraded", signals: ["compute_initializing"] });
        case "none":
          return runtimeState(ctx, node, id, { health: "unhealthy", signals: ["compute_missing"] });
        case "disabled":
          return runtimeState(ctx, node, id, { health: "unhealthy", signals: ["compute_connections_disabled"] });
        default:
          return runtimeState(ctx, node, id, { health: "unknown", signals: ["provider_project_exists", "compute_state_unknown"] });
      }
    },

    async verify(ctx, node, observed) {
      assertSessionMatches(ctx.session, ctx);
      const expected = node.kind === "postgres" ? this.expectedAttributes?.(node) ?? {} : {};
      const state = observed.attributes.computeState;
      const serving: "unknown" | boolean =
        state && state.state === "known" ? (state.value === "active" || state.value === "idle" ? true : state.value === "none" || state.value === "disabled" ? false : "unknown") : "unknown";
      const result = verifyAgainst(ctx, node, observed, expected, [
        {
          id: "serving",
          description: "the database's compute is running or scaled to zero (it wakes on connection)",
          passed: observed.presence === "present" ? serving : "unknown",
          detail: "Read from the provider's compute endpoint state; connectivity and credentials are not probed by this driver.",
        },
      ]);
      return node.kind === "postgres" ? result : { ...result, status: "failed" };
    },

    expectedAttributes(node) {
      const major = majorOf(node);
      return { managedByZenith: true, ...(major !== undefined ? { engineVersion: major } : {}) };
    },
  };
}
