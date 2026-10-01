/**
 * executeCapability — a day-two (or remediation) capability run natively.
 *
 * The operation names a catalog capability (`service.restart`, `service.scale`,
 * `database.snapshot`, …) and a target resource. This activity finds that
 * resource in the platform store, finds the driver operation registered under the
 * capability's name (`ResourceDriver.operations[capability]`) and runs it inside a
 * brokered session — deploy role for a mutating capability, observe role for a
 * read-only one — with the operation's own grant, the environment lease's fence in
 * the driver context, heartbeats and lease renewal.
 *
 * Refusals that happen BEFORE anything is touched are clean failures
 * (`StepFailedError`): unknown capability, no target, a target outside this
 * environment, a mutation aimed at a resource Zenith does not manage (referenced
 * and external resources are read, never changed), no driver or no such
 * operation. Once the driver operation starts, an exception is left plain: the
 * workflow finalizes `uncertain` because the call may have acted.
 *
 * The driver's result is bounded and recorded as evidence; `ok: false` is
 * returned, not thrown — the workflow turns it into a failed step. The grant's
 * `constraints` (policy "restrict") are NOT enforced here: `NativeOperation`
 * receives only the operation's own input, so a constraint the driver does not
 * already apply is not applied. Stated as a limit, not hidden.
 */
import { capability as lookupCapability, isCapability } from "@/lib/capabilities/catalog";
import { digest } from "@/lib/controlplane/digest";
import type { NativeOperation } from "@/lib/drivers/types";
import type { PortableKind, ProviderKey, ResourceNode } from "@/lib/resources/types";
import type { ExecutionActivities } from "@/lib/workflows/types";
import { loadExecContext, resolveConnection } from "./context";
import { assertLeaseFor } from "./desired";
import { StepFailedError } from "./errors";
import { withKeepAlive } from "./keepalive";
import type { StoredResource } from "./ports";
import type { Runtime } from "./runtime";
import { driverContext, purposeOf, withProviderSession } from "./session";
import { safeText } from "./text";

const MAX_DATA_BYTES = 4_000;

export function nodeFromStored(row: StoredResource, fallbackRegion: string): ResourceNode {
  return {
    address: row.address,
    kind: row.kind as PortableKind | "provider_native",
    provider: row.provider as ProviderKey,
    region: row.region ?? fallbackRegion,
    nativeType: row.nativeType,
    ownership: row.ownership,
    ...(row.externalId ? { externalRef: row.externalId } : {}),
    spec: row.spec,
    origin: row.origin,
    dependsOn: row.dependsOn,
    specDigest: row.specDigest,
    labels: row.labels,
  };
}

const boundedData = (data: Record<string, unknown> | undefined): { data?: Record<string, unknown>; dataTruncated?: true } => {
  if (!data) return {};
  const text = JSON.stringify(data);
  return text.length <= MAX_DATA_BYTES ? { data } : { dataTruncated: true };
};

export function createCapabilityActivities(rt: Runtime): Pick<ExecutionActivities, "executeCapability"> {
  return {
    async executeCapability({ operationId, lease }) {
      const ec = await loadExecContext(rt, operationId);
      assertLeaseFor(ec, lease);
      const name = ec.op.capability;
      if (!isCapability(name)) throw new StepFailedError(`"${safeText(name, 60)}" is not a capability this worker can execute.`);
      const def = lookupCapability(name);
      if (!ec.op.resourceId) throw new StepFailedError(`${name} names no target resource.`);

      const row = await rt.d.resources.get(ec.workspaceId, ec.op.resourceId);
      if (!row || row.environmentId !== ec.environmentId) throw new StepFailedError("The target resource was not found in this environment.");
      const node = nodeFromStored(row, ec.product.environment.region);
      if (def.mutates && node.ownership !== "managed") {
        throw new StepFailedError(`${node.address} is ${node.ownership}: Zenith reads it and never changes it, so ${name} cannot run on it.`);
      }
      const driver = rt.drivers(node.provider, node.nativeType);
      const operation: NativeOperation | undefined = driver?.operations?.[name];
      if (!driver || !operation) throw new StepFailedError(`No driver operation "${name}" exists for ${node.provider} ${node.nativeType}, so ${node.address} cannot ${def.title.toLowerCase()} natively.`);
      const connection = await resolveConnection(rt, ec);
      const input = ec.op.proposal.input !== null && typeof ec.op.proposal.input === "object" && !Array.isArray(ec.op.proposal.input) ? { ...(ec.op.proposal.input as Record<string, unknown>) } : {};

      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
      // "resource.applying" doubles as the marker that a mutating call was about to start (used to tell a cancelled-before-acting operation from an uncertain one).
      if (def.mutates) await rt.emit(ec.scope, "resource.applying", `capability:${ec.op.id}`, { capability: name, address: node.address });

      const result = await withKeepAlive(rt, { lease, detail: `execute ${name}`, operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, (signal) =>
        withProviderSession(rt, ec, { purpose: purposeOf(name), fence: lease, connection }, (session) =>
          operation(driverContext(rt, ec, session, signal, { node, fence: lease }), node, input)
        )
      );
      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);

      const summary = safeText(result.summary, 300);
      const body = {
        kind: "capability",
        capability: name,
        address: node.address,
        driver: driver.id,
        ok: result.ok,
        summary,
        requestIds: (result.requestIds ?? []).slice(0, 20).map((r) => safeText(r, 80)),
        ...boundedData(result.data),
      };
      await rt.evidence(ec.scope, { kind: "observation", digest: digest({ op: ec.op.id, capability: name, address: node.address, ok: result.ok, requestIds: body.requestIds }), summary: body, simulated: result.simulated, key: `capability:${ec.op.id}` }, { critical: true });
      if (result.ok && def.mutates) await rt.emit(ec.scope, "resource.applied", `capability:${ec.op.id}`, { capability: name, address: node.address });
      return { ok: result.ok, summary };
    },
  };
}
