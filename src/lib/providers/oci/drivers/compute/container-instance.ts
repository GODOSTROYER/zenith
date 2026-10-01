/**
 * `oci:container_instance` — portable `container_service` on OCI (Container
 * Instances: serverless containers, one instance per replica).
 *
 * One node compiles to:
 *   oci_core_network_security_group    `<label>_nsg`, the group the VNICs join
 *   oci_container_instances_container_instance  `count = replicas`, private
 *                                      subnet, NO public IP, resource principal
 *                                      enabled (the identity node's dynamic
 *                                      group matches these instances by tag)
 *   data oci_identity_availability_domains     replicas are spread across ADs
 *                                      (`element()` wraps) AND fault domains
 *   data oci_core_vnic (count)         the instances' private IPs, published as
 *                                      `local.<label>_private_ips` for the load
 *                                      balancer's backends
 *
 * SECRETS — the honest gap. The provider (oracle/oci 9.7.1) has no way to
 * inject an OCI Vault secret into a container instance as an environment
 * variable or volume; only `image_pull_secrets` reference Vault, and only for
 * external registries. So for an env entry `{ key, secretRef }` this driver
 *   - injects NO value and does NOT set `key` at all;
 *   - sets the NON-secret `ZENITH_SECRET_OCID_<KEY>` to the OCID of the Vault
 *     secret container (the `secret/*` node's id, or the customer's OCID when
 *     the secret is referenced), so the application can fetch the value at
 *     start-up with its resource principal (`read secret-bundles`, which the
 *     identity node grants scoped to that one secret);
 *   - lists any key it could NOT resolve to an OCID in the output
 *     `<label>_unresolved_secret_keys` (a name list, never a value).
 * Until the workload reads the secret itself, `key` is simply absent.
 *
 * Sizing: a container instance shape is flexible (`CI.Standard.E4.Flex`):
 * `ocpus = max(1, ceil(vcpu / 2))` (one OCPU is two vCPUs) and memory is
 * `max(ceil(memoryMb / 1024), ocpus)` GB, so the smallest sizes are rounded UP
 * to OCI's minimum of 1 OCPU / 1 GB. Container-level limits are left unset
 * (the container gets the instance's capacity).
 *
 * Not supported (compile throws): `built` and `blueprint` artifacts. OCI has no
 * build-pipeline driver, so a built image cannot exist; use an `image` source.
 *
 * Health: `web` services with a `port` get an HTTP health check on
 * `healthPath` (default "/") that kills and restarts an unhealthy container.
 */
import { createHash } from "node:crypto";
import type { CompileContext, NativeOperationResult, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import { secretAddress } from "@/lib/resources/expand-support";
import type { ContainerServiceSpec, EnvEntry } from "@/lib/resources/specs";
import type { HealthState, Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { compartmentOf } from "../../context";
import { OciCompileError, OciUnsupportedError } from "../../errors";
import { ociCapabilities, ociDriverId } from "../../evidence";
import { auxName, auxRef, interp, networkOf, nodeCloudName, zenithTags } from "../../naming";
import {
  arrayOrItems,
  asArray,
  asNumber,
  asRecord,
  asString,
  attributesOf,
  discoverWith,
  isGone,
  isZenithObject,
  listAll,
  observationOf,
  runtimeOf,
  unknownValue,
  unreadableObservation,
  verifyWith,
  known,
  type LocateDef,
  type Located,
  type OciContext,
} from "../../observe-kit";
import { isOcid, ociPath } from "../../services";
import { ociCall, type OciSession } from "../../transport";
import { addressList, assertPort, isManaged, readOnlyFragment, res, specOf } from "../shared";

export const CONTAINER_INSTANCE_NATIVE_TYPE = "oci:container_instance";
const ID = ociDriverId(CONTAINER_INSTANCE_NATIVE_TYPE);

export const DEFAULT_CI_SHAPE = "CI.Standard.E4.Flex";
const MAX_REPLICAS = 50;
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,400}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,200}$/;
const MAX_INSPECTED = 5;

export function capacity(spec: Pick<ContainerServiceSpec, "vcpu" | "memoryMb">): { ocpus: number; memoryGb: number } {
  const ocpus = Math.max(1, Math.ceil(spec.vcpu / 2));
  return { ocpus, memoryGb: Math.max(Math.ceil(spec.memoryMb / 1024), ocpus) };
}

function shapeOf(node: ResourceNode, spec: ContainerServiceSpec): string {
  const shape = spec.shape ?? DEFAULT_CI_SHAPE;
  if (!/^CI\.[A-Za-z0-9.]+\.Flex$/.test(shape)) throw new OciCompileError(`${node.address}: "${shape}" is not a Container Instances flexible shape (expected CI.<family>.Flex, e.g. ${DEFAULT_CI_SHAPE}).`);
  return shape;
}

function imageOf(node: ResourceNode, spec: ContainerServiceSpec): string {
  const a = spec.artifact;
  if (a.type !== "image") throw new OciUnsupportedError(`${node.address}: artifact type "${a.type}" cannot run on OCI Container Instances: there is no OCI build pipeline driver. Use an image source (for example an OCIR image).`);
  if (!IMAGE_REF.test(a.ref)) throw new OciCompileError(`${node.address}: image reference "${a.ref.slice(0, 80)}" is not a valid container image reference.`);
  return a.ref;
}

interface EnvResult {
  plain: Record<string, string>;
  unresolved: string[];
  delivered: string[];
}

/** Plain values pass through; secret refs become OCID pointers (see the module comment). */
function envFor(node: ResourceNode, ctx: CompileContext, entries: EnvEntry[]): EnvResult {
  const plain: Record<string, string> = {};
  const unresolved: string[] = [];
  const delivered: string[] = [];
  for (const e of [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    if (!ENV_KEY.test(e.key)) throw new OciCompileError(`${node.address}: env key "${e.key.slice(0, 60)}" is not a valid variable name.`);
    if ("secretRef" in e) {
      const target = ctx.node(secretAddress(e.secretRef));
      const name = `ZENITH_SECRET_OCID_${e.key.toUpperCase()}`;
      if (target?.ownership === "managed" && target.nativeType === "oci:vault_secret") {
        plain[name] = auxRef(target.address, "id");
        delivered.push(e.key);
      } else if (target && isOcid(target.externalRef)) {
        plain[name] = target.externalRef as string;
        delivered.push(e.key);
      } else {
        unresolved.push(e.key);
      }
    } else {
      plain[e.key] = e.value;
    }
  }
  return { plain, unresolved, delivered };
}

export function compileContainerInstance(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return readOnlyFragment();
  const spec = specOf<ContainerServiceSpec>(node);
  if (!Number.isInteger(spec.replicas) || spec.replicas < 0 || spec.replicas > MAX_REPLICAS) throw new OciCompileError(`${node.address}: replicas must be an integer in 0..${MAX_REPLICAS}.`);
  const image = imageOf(node, spec);
  const shape = shapeOf(node, spec);
  const { ocpus, memoryGb } = capacity(spec);
  const compartment = compartmentOf(ctx);
  const placement = networkOf(ctx, node, "private");
  const tags = zenithTags(ctx, node);
  const name = nodeCloudName(ctx, node, 90);
  const env = envFor(node, ctx, spec.env ?? []);

  const nsg = res("oci_core_network_security_group", node, "_nsg");
  const ci = res("oci_container_instances_container_instance", node);
  const ads = res("oci_identity_availability_domains", node, "_ads");
  const vnic = res("oci_core_vnic", node, "_vnic");

  const container: Record<string, unknown> = {
    display_name: name.slice(0, 60),
    image_url: image,
    is_resource_principal_disabled: false,
    ...(Object.keys(env.plain).length ? { environment_variables: env.plain } : {}),
  };
  if (spec.workload === "web" && spec.port !== undefined) {
    const port = assertPort(node, spec.port);
    container.health_checks = [
      {
        health_check_type: "HTTP",
        name: "http",
        port,
        path: spec.healthPath ?? "/",
        interval_in_seconds: 10,
        timeout_in_seconds: 3,
        failure_threshold: 3,
        success_threshold: 1,
        initial_delay_in_seconds: 30,
        failure_action: "KILL",
      },
    ];
  }

  const output: NonNullable<TofuFragment["output"]> = {};
  if (env.unresolved.length) {
    output[`${ci.label}_unresolved_secret_keys`] = {
      value: env.unresolved,
      description: `Secret env keys of ${node.address} that could not be resolved to an OCI Vault secret OCID; they are NOT delivered to the container.`,
    };
  }
  if (env.delivered.length) {
    output[`${ci.label}_secret_delivery`] = {
      value: { mode: "runtime_fetch", keys: env.delivered },
      description: `Container Instances cannot inject Vault secrets as env vars; ${node.address} must read these keys with its resource principal using ZENITH_SECRET_OCID_<KEY>.`,
    };
  }

  return {
    data: {
      oci_identity_availability_domains: { [ads.label]: { compartment_id: compartment } },
      oci_core_vnic: { [vnic.label]: { count: spec.replicas, vnic_id: interp(`${ci.address}[count.index].vnics[0].vnic_id`) } },
    },
    resource: {
      oci_core_network_security_group: { [nsg.label]: { compartment_id: compartment, vcn_id: ctx.ref(placement.network, "id"), display_name: `${name}-nsg`, freeform_tags: tags } },
      oci_container_instances_container_instance: {
        [ci.label]: {
          count: spec.replicas,
          compartment_id: compartment,
          availability_domain: interp(`element(data.${ads.address}.availability_domains[*].name, count.index)`),
          fault_domain: `FAULT-DOMAIN-${interp("count.index % 3 + 1")}`,
          display_name: `${name}-${interp("count.index + 1")}`,
          shape,
          shape_config: { ocpus, memory_in_gbs: memoryGb },
          container_restart_policy: "ALWAYS",
          graceful_shutdown_timeout_in_seconds: "30",
          containers: [container],
          vnics: [{ subnet_id: ctx.ref(placement.subnets[0], "id"), nsg_ids: [interp(`${nsg.address}.id`)], is_public_ip_assigned: false, display_name: `${name}-vnic` }],
          freeform_tags: tags,
        },
      },
    },
    locals: {
      [auxName(node.address, "nsg_id")]: interp(`${nsg.address}.id`),
      [auxName(node.address, "private_ips")]: interp(`[for v in data.${vnic.address} : v.private_ip_address]`),
    },
    ...(Object.keys(output).length ? { output } : {}),
    addresses: addressList(ci.address, [nsg.address, `data.${ads.address}`, `data.${vnic.address}`]),
  };
}

export function containerInstanceExpected(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<ContainerServiceSpec>(node);
  const { ocpus, memoryGb } = capacity(spec);
  return {
    replicas: spec.replicas,
    shape: spec.shape ?? DEFAULT_CI_SHAPE,
    ocpus,
    memoryGb,
    ...(spec.artifact.type === "image" ? { image: spec.artifact.ref } : {}),
  };
}

/* --------------------------------- observe --------------------------------- */

const listDef = (compartmentId: string) => ({ path: ociPath("containerinstances", "containerInstances"), query: { compartmentId } });
const locateDef: LocateDef = {
  service: "containerinstances",
  get: (id) => ({ path: ociPath("containerinstances", "containerInstances", id) }),
  list: listDef,
  items: arrayOrItems,
  idOf: (i) => asString(asRecord(i)?.id),
};

type Instance = Record<string, unknown>;

type Found =
  | { ok: true; instances: Instance[]; requestIds: string[]; truncated: boolean }
  | { ok: false; located: Located };

/** Every tagged, not-gone instance of this node (replicas are separate objects). */
async function findInstances(ctx: OciContext, node: ResourceNode): Promise<Found> {
  const listed = await listAll(ctx, { service: "containerinstances", region: node.region || ctx.region, method: "GET", ...listDef(ctx.session.compartmentOcid) }, arrayOrItems);
  if (!listed.ok) {
    const f = listed.failure;
    const presence = f.outcome === "denied" || f.outcome === "not_found" ? "inaccessible" : "unknown";
    return { ok: false, located: { presence, requestIds: listed.requestIds, error: f.message } };
  }
  const instances = listed.items.filter((i): i is Instance => asRecord(i) !== undefined && !isGone(i) && isZenithObject(i, ctx.environmentId, node.address)).sort((a, b) => ((asString(a.id) ?? "") < (asString(b.id) ?? "") ? -1 : 1));
  return { ok: true, instances, requestIds: listed.requestIds, truncated: listed.truncated };
}

const common = (values: (string | number | undefined)[]): string | number | undefined | "mixed" => {
  const set = new Set(values.filter((v) => v !== undefined));
  return set.size === 0 ? undefined : set.size === 1 ? [...set][0] : "mixed";
};

/** The image each of the first few instances runs: instance → first container → its `imageUrl`. */
async function imagesOf(ctx: OciContext, node: ResourceNode, instances: Instance[], requestIds: string[]): Promise<{ image?: string; complete: boolean }> {
  const images: string[] = [];
  const inspect = instances.slice(0, MAX_INSPECTED);
  for (const inst of inspect) {
    const id = asString(inst.id);
    if (!id) continue;
    const full = await ociCall(ctx, { service: "containerinstances", region: node.region || ctx.region, method: "GET", path: ociPath("containerinstances", "containerInstances", id) });
    if (full.requestId) requestIds.push(full.requestId);
    if (!full.ok) return { complete: false };
    const cid = asString(asRecord(asArray(asRecord(full.body)?.containers)[0])?.containerId);
    if (!cid) return { complete: false };
    const c = await ociCall(ctx, { service: "containerinstances", region: node.region || ctx.region, method: "GET", path: ociPath("containerinstances", "containers", cid) });
    if (c.requestId) requestIds.push(c.requestId);
    const image = c.ok ? asString(asRecord(c.body)?.imageUrl) : undefined;
    if (!image) return { complete: false };
    images.push(image);
  }
  const one = common(images);
  return { image: one === "mixed" ? "mixed" : typeof one === "string" ? one : undefined, complete: instances.length <= MAX_INSPECTED };
}

export async function observeContainerInstance(ctx: OciContext, node: ResourceNode, _externalId?: string): Promise<Observation> {
  const found = await findInstances(ctx, node);
  if (!found.ok) return unreadableObservation(ctx, node, ID, found.located.error ?? "unreadable", found.located.presence);
  const { instances } = found;
  if (instances.length === 0) {
    const spec = specOf<ContainerServiceSpec>(node);
    // a service with zero desired replicas legitimately has no instance; absence is only proven on a complete listing
    if (found.truncated) return unreadableObservation(ctx, node, ID, "No instance found in a truncated listing; absence cannot be concluded.");
    return observationOf(ctx, node, ID, { presence: spec.replicas === 0 ? "present" : "missing", requestIds: found.requestIds }, spec.replicas === 0 ? { replicas: known(0, ctx.now().toISOString()) } : {});
  }
  const at = ctx.now().toISOString();
  const requestIds = [...found.requestIds];
  const cfg = (i: Instance) => asRecord(i.shapeConfig);
  const ocpus = common(instances.map((i) => asNumber(cfg(i)?.ocpus)));
  const mem = common(instances.map((i) => asNumber(cfg(i)?.memoryInGBs)));
  const { image } = await imagesOf(ctx, node, instances, requestIds);
  const attributes = {
    ...attributesOf(at, { replicas: instances.length, shape: common(instances.map((i) => asString(i.shape))), ocpus, memoryGb: mem, image }),
  };
  if (found.truncated) attributes.replicas = unknownValue("not_inspected", "listing truncated");
  const only = instances.length === 1 ? asString(instances[0].id) : undefined;
  return observationOf(ctx, node, ID, { presence: "present", item: instances[0], externalId: only, requestIds }, attributes, {
    instances: instances.slice(0, 8).map((i) => ({ id: i.id, state: i.lifecycleState, fd: i.faultDomain, ad: i.availabilityDomain })),
    instanceCount: instances.length,
  });
}

export async function runtimeContainerInstance(ctx: OciContext, node: ResourceNode, _externalId?: string): Promise<RuntimeState> {
  const found = await findInstances(ctx, node);
  if (!found.ok) return runtimeOf(ctx, node, ID, "unknown", {}, [`presence:${found.located.presence}`]);
  const spec = specOf<ContainerServiceSpec>(node);
  const states = found.instances.map((i) => asString(i.lifecycleState) ?? "UNKNOWN");
  const count = (...s: string[]) => states.filter((x) => s.includes(x)).length;
  const counts: Record<string, number> = { desired: spec.replicas, running: count("ACTIVE"), pending: count("CREATING", "UPDATING"), failed: count("FAILED"), stopped: count("INACTIVE") };
  const signals: string[] = [];
  if (counts.failed) signals.push(`instance_failed:${counts.failed}`);
  if (counts.stopped) signals.push(`instance_inactive:${counts.stopped}`);
  if (counts.pending) signals.push(`instance_pending:${counts.pending}`);
  if (found.truncated) signals.push("listing_truncated");
  let health: HealthState;
  if (found.truncated) health = "unknown";
  else if (spec.replicas === 0) health = "healthy";
  else if (counts.running >= spec.replicas && counts.failed === 0) health = "healthy";
  else if (counts.running === 0) health = "unhealthy";
  else health = "degraded";
  return runtimeOf(ctx, node, ID, health, counts, signals);
}

/* ------------------------------- operations -------------------------------- */

/**
 * `service.restart`: restart each ACTIVE tagged instance, one at a time, stopping
 * at the first failure. Retry tokens derive from the operation id + instance id.
 * Replicas restart sequentially but each restart takes its instance down; with
 * one replica this is an outage.
 */
async function restart(ctx: OciContext, node: ResourceNode): Promise<NativeOperationResult> {
  const opId = ctx.operationId;
  if (!opId) return { ok: false, simulated: false, summary: "service.restart needs an operation id for idempotency." };
  const found = await findInstances(ctx, node);
  if (!found.ok) return { ok: false, simulated: false, summary: found.located.error ?? "The instances could not be listed; nothing was restarted.", requestIds: found.located.requestIds };
  const active = found.instances.filter((i) => asString(i.lifecycleState) === "ACTIVE");
  if (active.length === 0) return { ok: false, simulated: false, summary: `No ACTIVE instance of ${node.address} to restart.`, requestIds: found.requestIds };
  const requestIds = [...found.requestIds];
  let done = 0;
  for (const inst of active) {
    const id = asString(inst.id)!;
    const token = `zenith-${createHash("sha256").update(`oci-restart\0${opId}\0${id}`).digest("hex").slice(0, 32)}`;
    const r = await ociCall(ctx, { service: "containerinstances", region: node.region || ctx.region, method: "POST", path: ociPath("containerinstances", "containerInstances", id, "actions", "restart"), headers: { "opc-retry-token": token } });
    if (r.requestId) requestIds.push(r.requestId);
    if (!r.ok) return { ok: false, simulated: false, summary: `Restarted ${done} of ${active.length} instances; the next failed: ${r.message}`, data: { restarted: done, total: active.length }, requestIds };
    done++;
  }
  return { ok: true, simulated: false, summary: `Restart requested for ${done} instance${done === 1 ? "" : "s"} of ${node.address}.`, data: { restarted: done, total: active.length }, requestIds };
}

export const containerInstanceDriver: ResourceDriver<OciSession> = {
  id: ID,
  provider: "oci",
  kind: "container_service",
  nativeType: CONTAINER_INSTANCE_NATIVE_TYPE,
  capabilities: ociCapabilities({ compile: true, observe: true, runtime: true, verify: true, discover: true, operations: ["service.restart"] }),
  compile: compileContainerInstance,
  observe: observeContainerInstance,
  runtime: runtimeContainerInstance,
  expectedAttributes: containerInstanceExpected,
  verify: async (ctx, node, observation, runtime) => verifyWith({ node, observation, expected: containerInstanceExpected(node), runtime, now: ctx.now() }),
  discover: (ctx) =>
    discoverWith(ctx, {
      ...locateDef,
      kind: "container_service",
      nativeType: CONTAINER_INSTANCE_NATIVE_TYPE,
      nameOf: (i) => asString(i.displayName) ?? asString(i.id) ?? "container instance",
      attributes: (i) => ({ state: asString(i.lifecycleState) ?? "", shape: asString(i.shape) ?? "" }),
    }),
  operations: { "service.restart": async (ctx, node) => restart(ctx, node) },
};

