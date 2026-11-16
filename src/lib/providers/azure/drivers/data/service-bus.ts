/**
 * `azure:service_bus_queue` (portable `queue`) and `azure:service_bus_topic`
 * (portable `pubsub`) on Azure Service Bus.
 *
 * Ownership: one NAMESPACE per node (the namespace is the billable, globally
 * named, taggable unit; a shared per-environment namespace would need an owner
 * among nodes that cannot see each other). Consequence to know: a Standard
 * namespace has a fixed monthly base charge per node. Size picks the tier:
 * nano/small → Basic (queues only), standard/performance → Standard;
 * `config.sku` ("Basic" | "Standard") overrides; topics always need Standard.
 * Premium is refused: it is the only tier with private endpoints and network
 * rules, and its cost (hundreds of dollars a month per unit) is not something
 * to choose implicitly.
 *
 * Security posture:
 *   - Entra ID only: `local_auth_enabled = false` (no SAS keys, no connection
 *     strings), minimum TLS 1.2; access is granted to workload identities as
 *     "Azure Service Bus Data Sender/Receiver" scoped to the queue/topic.
 *   - PUBLIC ENDPOINT REMAINS: Basic/Standard namespaces cannot be made private
 *     (private endpoints and IP/VNet rules are Premium-only). Every call needs
 *     an Entra token with a data-plane role. This is the one data service that
 *     is not network-private; tests assert exactly that, and why.
 *   - `prevent_destroy` + `CanNotDelete` lock unless `deletionPolicy: allow`.
 *
 * Queue defaults: 10 deliveries then dead-letter (Standard), 1-minute lock,
 * 14-day TTL (the Basic maximum).
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { QueueSpec } from "@/lib/resources/specs";
import { AzureCompileError, block, configString, fragment, mergeBlocks, resolveNetwork, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { defineAzureDriver, getById, locateByTags, pick, props, type AzureCtx, type Located, type RuntimeRead } from "@/lib/providers/azure/kit";
import { armClient, type ArmResource, type Json } from "@/lib/providers/azure/arm";
import { azureTags, cloudName, scopedName, tfLabel } from "@/lib/providers/azure/naming";
import { API } from "@/lib/providers/azure/platform";
import { deletionLock, protectFromDestroy } from "@/lib/providers/azure/drivers/data/private-endpoint";

export const SERVICE_BUS_NAMESPACE = { type: "Microsoft.ServiceBus/namespaces", apiVersion: API.serviceBus } as const;

type Tier = "Basic" | "Standard";

export function serviceBusTier(node: ResourceNode, kind: "queue" | "topic"): Tier {
  const spec = specOf<QueueSpec>(node);
  const override = configString(node, "sku");
  if (override !== undefined) {
    const t = override.toLowerCase();
    if (t === "premium") throw new AzureCompileError("Service Bus Premium is not selected implicitly (fixed cost per messaging unit); use Standard or Basic.", node.address);
    if (t !== "basic" && t !== "standard") throw new AzureCompileError(`config.sku must be Basic or Standard, got "${override.slice(0, 20)}".`, node.address);
    if (t === "basic" && kind === "topic") throw new AzureCompileError("topics need the Standard tier.", node.address);
    return t === "basic" ? "Basic" : "Standard";
  }
  if (kind === "topic") return "Standard";
  return spec.size === "nano" || spec.size === "small" ? "Basic" : "Standard";
}

function compileBus(node: ResourceNode, ctx: CompileContext, kind: "queue" | "topic"): TofuFragment {
  const spec = specOf<QueueSpec>(node);
  const a = node.address;
  const net = resolveNetwork(node, ctx);
  const tier = serviceBusTier(node, kind);
  const L = (part: string) => tfLabel(a, part);
  const ns = `azurerm_servicebus_namespace.${L("ns")}`;
  const entityType = kind === "queue" ? "azurerm_servicebus_queue" : "azurerm_servicebus_topic";
  const entityBody: Record<string, unknown> =
    kind === "queue"
      ? { name: scopedName(a, { max: 260 }), namespace_id: `\${${ns}.id}`, max_delivery_count: 10, lock_duration: "PT1M", default_message_ttl: "P14D" }
      : { name: scopedName(a, { max: 260 }), namespace_id: `\${${ns}.id}`, default_message_ttl: "P14D" };
  const entity = `${entityType}.${L(kind)}`;
  const resource = mergeBlocks(
    block("azurerm_servicebus_namespace", L("ns"), {
      name: cloudName(ctx, a, { max: 50, suffix: "bus" }),
      location: node.region,
      resource_group_name: exportRef(net, "rg_name"),
      sku: tier,
      local_auth_enabled: false,
      minimum_tls_version: "1.2",
      tags: azureTags(ctx, node),
      lifecycle: { prevent_destroy: protectFromDestroy(spec.deletionPolicy) },
    }),
    block(entityType, L(kind), entityBody),
    deletionLock(node, `\${${ns}.id}`, spec.deletionPolicy)
  );
  return fragment({
    resource,
    locals: exportLocals(a, { id: `\${${entity}.id}`, name: `\${${entity}.name}`, namespace_id: `\${${ns}.id}` }),
  });
}

export const compileServiceBusQueue = (node: ResourceNode, ctx: CompileContext): TofuFragment => compileBus(node, ctx, "queue");
export const compileServiceBusTopic = (node: ResourceNode, ctx: CompileContext): TofuFragment => compileBus(node, ctx, "topic");

/* --------------------------------- observe ---------------------------------- */

function locateEntity(kind: "queue" | "topic") {
  return async (ctx: AzureCtx, node: ResourceNode, externalId?: string): Promise<Located> => {
    const found = await locateByTags(ctx, node, SERVICE_BUS_NAMESPACE, externalId);
    if (found.state !== "found") return found;
    const arm = armClient(ctx.session, ctx.signal);
    const entity = await getById(arm, `${found.resource.id}/${kind === "queue" ? "queues" : "topics"}/${scopedName(node.address, { max: 260 })}`, API.serviceBus);
    const extra: Json = { zenithEntityState: entity.state };
    if (entity.state === "found") extra.zenithEntity = props(entity.resource);
    return { state: "found", resource: { ...found.resource, properties: { ...props(found.resource), ...extra } } };
  };
}

function expectedBus(kind: "queue" | "topic") {
  return (node: ResourceNode): Record<string, unknown> => {
    const out: Record<string, unknown> = { tier: serviceBusTier(node, kind), localAuth: "Disabled", minimumTls: "1.2" };
    if (kind === "queue") out.maxDeliveryCount = 10;
    return out;
  };
}

function readBus(kind: "queue" | "topic") {
  return (res: ArmResource): Record<string, unknown> => {
    const p = props(res);
    const disabled = pick<boolean>(p, "disableLocalAuth");
    return {
      tier: pick<string>(res.sku, "name"),
      localAuth: disabled === undefined ? undefined : disabled ? "Disabled" : "Enabled",
      minimumTls: pick<string>(p, "minimumTlsVersion"),
      ...(kind === "queue" ? { maxDeliveryCount: pick<number>(p, "zenithEntity", "maxDeliveryCount") } : {}),
    };
  };
}

const busChecks = (kind: "queue" | "topic") => (_ctx: AzureCtx, _node: ResourceNode, res: ArmResource) => {
  const state = props(res).zenithEntityState;
  const status = pick<string>(props(res), "zenithEntity", "status");
  return [
    { id: kind, description: `the ${kind} exists`, passed: state === "found" ? true : state === "missing" ? false : ("unknown" as const), detail: `${kind} ${String(state ?? "not read")}` },
    ...(state === "found" ? [{ id: "status", description: `the ${kind} is Active`, passed: status === "Active", detail: `status=${String(status)}` }] : []),
  ];
};

const busRuntime = async (_ctx: unknown, _node: ResourceNode, res: ArmResource): Promise<RuntimeRead> => {
  const d = pick<Json>(props(res), "zenithEntity", "countDetails");
  const counts: Record<string, number> = {};
  const signals: string[] = [];
  for (const [key, label] of [["activeMessageCount", "active"], ["deadLetterMessageCount", "deadLetter"], ["scheduledMessageCount", "scheduled"]] as const) {
    const v = d?.[key];
    if (typeof v === "number") counts[label] = v;
  }
  if ((counts.deadLetter ?? 0) > 0) signals.push(`dead_letter_messages:${counts.deadLetter}`);
  if (!d) return { health: "unknown", counts, signals: ["counts_not_reported"] };
  return { health: (counts.deadLetter ?? 0) > 0 ? "degraded" : "healthy", counts, signals };
};

const busNative = (res: ArmResource) => ({ provisioningState: props(res).provisioningState, endpoint: props(res).serviceBusEndpoint, status: pick(props(res), "zenithEntity", "status") });

export const serviceBusQueueDriver = defineAzureDriver({
  id: "azure.service_bus_queue@1",
  kind: "queue",
  nativeType: "azure:service_bus_queue",
  arm: SERVICE_BUS_NAMESPACE,
  locate: locateEntity("queue"),
  compile: compileServiceBusQueue,
  expected: expectedBus("queue"),
  read: readBus("queue"),
  native: busNative,
  checks: busChecks("queue"),
  runtime: busRuntime,
});

export const serviceBusTopicDriver = defineAzureDriver({
  id: "azure.service_bus_topic@1",
  kind: "pubsub",
  nativeType: "azure:service_bus_topic",
  arm: SERVICE_BUS_NAMESPACE,
  locate: locateEntity("topic"),
  compile: compileServiceBusTopic,
  expected: expectedBus("topic"),
  read: readBus("topic"),
  native: busNative,
  checks: busChecks("topic"),
  runtime: busRuntime,
});
