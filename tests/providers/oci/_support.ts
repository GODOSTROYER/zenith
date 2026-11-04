/**
 * Shared support for the OCI driver tests: a real expansion of an OCI
 * environment, a compile pass over the whole graph with the OCI drivers, and a
 * fake `OciApiTransport`. Underscore-prefixed so vitest does not collect it.
 *
 * Nothing here talks to OCI. The fake transport is a scripted stand-in: every
 * observe/runtime/verify result in these tests proves the DRIVER's handling of
 * the responses it is given, never that OCI answers that way.
 */
import type { Binding, Manifest, Resource, Route, Service } from "@/lib/domain/types";
import type { CompileContext, DriverContext, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import { expandManifest, type ExpandEnv, type ResourceGraph, type ResourceNode } from "@/lib/resources";
import { ociDrivers } from "@/lib/providers/oci/drivers";
import { ociCompileContext } from "@/lib/providers/oci/context";
import { ociPrimaryAddress } from "@/lib/providers/oci/naming";
import type { OciApiRequest, OciApiResponse, OciApiTransport, OciSession } from "@/lib/providers/oci/transport";

export const COMPARTMENT = "ocid1.compartment.oc1..aaaaaaaacompartmentexample0001";
export const TENANCY = "ocid1.tenancy.oc1..aaaaaaaatenancyexample0002";
export const REGION = "us-ashburn-1";
export const ENV_ID = "env-oci";

export const OCI_ENV: ExpandEnv = { id: ENV_ID, name: "staging", class: "staging", provider: "oci", region: REGION, baseDomain: "atlas.zenith.test" };
export const OCI_PROD: ExpandEnv = { ...OCI_ENV, id: "env-oci-prod", name: "production", class: "production" };

/* -------------------------------- manifests -------------------------------- */

const svc = (over: Partial<Service> & Pick<Service, "id" | "name" | "kind">): Service => ({ source: { type: "image", image: "iad.ocir.io/acme/app:1" }, size: "small", replicas: 2, env: [], ownership: "managed", ...over });
const res = (over: Partial<Resource> & Pick<Resource, "id" | "name" | "kind">): Resource => ({ config: {}, size: "small", ownership: "managed", ...over });
const route = (over: Partial<Route> & Pick<Route, "id" | "host">): Route => ({ pathPrefix: "/", tls: true, managedDns: true, ...over });
const bind = (id: string, from: string, to: string, capability: Binding["capability"]): Binding => ({ id, from, to, capability });

/** web + worker + postgres + redis + bucket + queue + a TLS route with managed DNS, and a vault secret. */
export function webStack(): Manifest {
  return {
    version: 1,
    services: [
      svc({
        id: "svc-web",
        name: "web",
        kind: "web",
        port: 3000,
        healthPath: "/healthz",
        replicas: 2,
        env: [
          { key: "LOG_LEVEL", value: "info" },
          { key: "SESSION_SECRET", secretRef: "vault:proj/svc-web/SESSION_SECRET" },
          { key: "STRIPE_KEY", secretRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:stripe" },
        ],
      }),
      svc({ id: "svc-worker", name: "worker", kind: "worker", replicas: 1, env: [{ key: "SESSION_SECRET", secretRef: "vault:proj/svc-web/SESSION_SECRET" }] }),
    ],
    resources: [
      res({ id: "res-db", name: "db", kind: "postgres", size: "standard", config: { version: "16" } }),
      res({ id: "res-cache", name: "cache", kind: "redis" }),
      res({ id: "res-assets", name: "assets", kind: "object_store" }),
      res({ id: "res-jobs", name: "jobs", kind: "queue" }),
    ],
    routes: [route({ id: "rt-app", host: "app.acme.io" })],
    bindings: [
      bind("b-route", "rt-app", "svc-web", "http"),
      bind("b-sql", "svc-web", "res-db", "sql"),
      bind("b-cache", "svc-web", "res-cache", "cache"),
      bind("b-blob", "svc-web", "res-assets", "blob"),
      bind("b-pub", "svc-web", "res-jobs", "queue_publish"),
      bind("b-sub", "svc-worker", "res-jobs", "queue_consume"),
      bind("b-sql2", "svc-worker", "res-db", "sql"),
    ],
  };
}

export const expandOci = (m: Manifest = webStack(), env: ExpandEnv = OCI_ENV): ResourceGraph => expandManifest(m, env);

/* --------------------------------- compile --------------------------------- */

export function driverFor(node: ResourceNode): ResourceDriver<OciSession> {
  const d = ociDrivers.find((x) => x.nativeType === node.nativeType);
  if (!d) throw new Error(`no OCI driver for ${node.nativeType} (${node.address})`);
  return d;
}

/** A `CompileContext` whose `ref()` targets the node's primary resource, as the orchestrator is expected to. */
export function compileContext(graph: ResourceGraph, over: Partial<CompileContext> = {}): CompileContext {
  const byAddress = new Map(graph.nodes.map((n) => [n.address, n]));
  const base: CompileContext = {
    environmentId: graph.environmentId,
    namePrefix: "zn-acme",
    region: REGION,
    tags: { "zenith:workspace": "ws_1", "zenith:environment": graph.environmentId, "zenith:managed": "true" },
    ref(address, attribute) {
      const n = byAddress.get(address);
      const primary = n ? ociPrimaryAddress(n) : undefined;
      if (!primary) throw new Error(`ref(): ${address} has no primary OCI resource`);
      return "${" + `${primary}.${attribute}` + "}";
    },
    node: (address) => byAddress.get(address),
    ...over,
  };
  return ociCompileContext(base, { compartmentOcid: COMPARTMENT, tenancyOcid: TENANCY });
}

export interface CompiledGraph {
  graph: ResourceGraph;
  fragments: Map<string, TofuFragment>;
  /** nodes whose driver refuses (unsupported) → the refusal message */
  refused: Map<string, string>;
}

export function compileGraph(graph: ResourceGraph, over: Partial<CompileContext> = {}): CompiledGraph {
  const ctx = compileContext(graph, over);
  const fragments = new Map<string, TofuFragment>();
  const refused = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.provider !== "oci" || node.nativeType.startsWith("unsupported:")) {
      refused.set(node.address, `no OCI driver for ${node.nativeType}`);
      continue;
    }
    try {
      fragments.set(node.address, driverFor(node).compile!(node, ctx));
    } catch (e) {
      refused.set(node.address, e instanceof Error ? e.message : String(e));
    }
  }
  return { graph, fragments, refused };
}

/** Graph restricted to nodes that compiled (assembly rejects fragments for unknown nodes; unrealized nodes are simply absent). */
export const compiledNodes = (c: CompiledGraph): ResourceNode[] => c.graph.nodes.filter((n) => c.fragments.has(n.address));

export function nodeOf(graph: ResourceGraph, address: string): ResourceNode {
  const n = graph.nodes.find((x) => x.address === address);
  if (!n) throw new Error(`no node ${address}; have ${graph.nodes.map((x) => x.address).join(", ")}`);
  return n;
}

/** All resource bodies of a fragment, flattened: `{ type, name, body }`. */
export function resourcesOf(f: TofuFragment): { type: string; name: string; body: Record<string, unknown> }[] {
  const out: { type: string; name: string; body: Record<string, unknown> }[] = [];
  for (const [type, named] of Object.entries(f.resource ?? {})) for (const [name, body] of Object.entries(named)) out.push({ type, name, body });
  return out;
}

export function allResources(c: CompiledGraph): { node: string; type: string; name: string; body: Record<string, unknown> }[] {
  return [...c.fragments.entries()].flatMap(([node, f]) => resourcesOf(f).map((r) => ({ node, ...r })));
}

/* ------------------------------ fake transport ------------------------------ */

export interface Recorded {
  req: OciApiRequest;
}

type Handler = (req: OciApiRequest) => OciApiResponse | undefined | Promise<OciApiResponse | undefined>;

export class FakeOci implements OciApiTransport {
  readonly calls: OciApiRequest[] = [];
  private readonly handlers: Handler[] = [];
  /** throw this from `request` (transport failure) */
  failWith?: Error;

  /** first matching handler wins; unmatched requests get 404 NotAuthorizedOrNotFound, like OCI */
  on(handler: Handler): this {
    this.handlers.unshift(handler);
    return this;
  }

  route(method: string, pathTest: string | RegExp, respond: OciApiResponse | ((req: OciApiRequest) => OciApiResponse)): this {
    return this.on((req) => {
      if (req.method !== method) return undefined;
      const ok = typeof pathTest === "string" ? req.path === pathTest : pathTest.test(req.path);
      if (!ok) return undefined;
      return typeof respond === "function" ? respond(req) : respond;
    });
  }

  async request(req: OciApiRequest): Promise<OciApiResponse> {
    this.calls.push(structuredClone(req));
    if (this.failWith) throw this.failWith;
    for (const h of this.handlers) {
      const r = await h(req);
      if (r) return r;
    }
    return { status: 404, headers: { "opc-request-id": "req-unmatched" }, body: { code: "NotAuthorizedOrNotFound", message: "Authorization failed or requested resource not found." } };
  }

  get methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

export const json = (body: unknown, headers: Record<string, string> = {}, status = 200): OciApiResponse => ({ status, headers: { "opc-request-id": "req-1", ...headers }, body });
export const err = (status: number, code: string, message = "boom", headers: Record<string, string> = {}): OciApiResponse => ({ status, headers: { "opc-request-id": "req-err", ...headers }, body: { code, message } });

export const NOW = new Date("2026-09-30T12:00:00.000Z");

export function driverContext(transport: OciApiTransport, over: Partial<DriverContext<OciSession>> = {}, session: Partial<OciSession> = {}): DriverContext<OciSession> {
  return {
    provider: "oci",
    region: REGION,
    workspaceId: "ws_1",
    environmentId: ENV_ID,
    operationId: "op_test_1",
    session: { provider: "oci", region: REGION, compartmentOcid: COMPARTMENT, tenancyOcid: TENANCY, transport, ...session },
    signal: new AbortController().signal,
    log: () => undefined,
    tags: { "zenith:workspace": "ws_1", "zenith:environment": ENV_ID, "zenith:managed": "true" },
    now: () => NOW,
    ...over,
  };
}

/** The Zenith tag set an OCI object created by these drivers carries (free-form keys, as compiled). */
export const zenithTagsFor = (address: string, env = ENV_ID): Record<string, string> => ({ zenith_environment: env, zenith_resource: address, zenith_managed: "true", zenith_workspace: "ws_1" });

export const ocid = (type: string, n: string): string => `ocid1.${type}.oc1.${REGION}.${n.padEnd(12, "x")}`;
