/**
 * Exportability: the same app as plain Kubernetes manifests plus a README that
 * says how to run it on ANY cluster, with no Zenith in the loop. This is the
 * "no lock-in" promise for the managed platform made concrete and testable.
 *
 *   exportKubernetesBundle(input) → { files, digest, excluded, secrets, notes }
 *
 * What the bundle is: the Kubernetes provider's own render of the environment
 * (`toolkit.renderGraph`: the same Deployments, Services, Ingress, cert-manager
 * Certificates and NetworkPolicies the managed platform applies), with
 *   - the user's ORIGINAL hostnames (not the managed ones) and an `Ingress`
 *     (what every cluster has), not a platform-specific HTTPRoute;
 *   - the namespace you choose, not the tenant namespace;
 *   - Zenith's `zenith.dev/*` ownership annotations removed, so the objects do
 *     not claim to be managed by Zenith and a Zenith install that later meets
 *     them reports an ownership conflict instead of adopting them;
 *   - no Secret objects: a Secret carries no value in Zenith's model, so
 *     exporting an empty one would only break the app. The README lists every
 *     Secret name and key to create instead.
 *
 * What the bundle is NOT, and says so: the managed Postgres is not in it (it is
 * an external service, not a manifest), DNS records are not in it, and the
 * platform's tenancy baseline (restricted Pod Security, default-deny with
 * gateway-only ingress, quotas) is not reproduced: the bundle carries the
 * portable baseline the Kubernetes provider renders, nothing tenant-specific.
 *
 * The one real lock-in risk, stated in the README and in
 * docs/platform/MANAGED-PLATFORM.md: the managed database's connection string
 * lives in the Zenith vault, which has no value export, and this module has no
 * dump/export operation for the database. Moving the DATA needs a platform
 * operation that does not exist yet. The schema of the README's database section
 * is honest about it.
 *
 * Deterministic: no clock, no randomness; same input, byte-identical bundle.
 */
import { dump } from "js-yaml";
import { digest } from "@/lib/controlplane/digest";
import type { ResourceNode } from "@/lib/resources/types";
import { managedDatabaseConnectionRef } from "./database";
import { OWNERSHIP, isRecord, type K8sObject, type KubernetesToolkit } from "./k8s-port";
import { NOT_OFFERED, UNSUPPORTED } from "./platform";
import { dnsLabelOf } from "./tenancy";
import { ZenithError } from "./types";

export interface ExportInput {
  environmentId: string;
  /** names the bundle in its README; free text, never parsed */
  title: string;
  nodes: readonly ResourceNode[];
  toolkit: Pick<KubernetesToolkit, "renderGraph">;
  /** target namespace; default `app` */
  namespace?: string;
  /** default `nginx` */
  ingressClass?: string;
  /** cert-manager ClusterIssuer name the Certificates reference; default `letsencrypt-prod` */
  clusterIssuer?: string;
  /** pipeline name → image reference the target cluster can pull, for `built` artifacts */
  builtImages?: Readonly<Record<string, string>>;
}

export interface ExportedFile {
  path: string;
  content: string;
}

export interface ExcludedNode {
  address: string;
  kind: string;
  reason: string;
}

export interface ExportedSecret {
  /** the Kubernetes Secret name the workloads reference */
  name: string;
  key: string;
  /** the logical reference it stood for in Zenith (a pointer, never a value) */
  reference: string;
  note?: string;
}

export interface ExportBundle {
  files: ExportedFile[];
  /** identity of the bundle: SHA-256 over the canonical file list */
  digest: string;
  namespace: string;
  hosts: string[];
  excluded: ExcludedNode[];
  secrets: ExportedSecret[];
  notes: string[];
}

const DEFAULT_NAMESPACE = "app";
const DEFAULT_INGRESS_CLASS = "nginx";
const DEFAULT_ISSUER = "letsencrypt-prod";
const SECRET_KEY = "value";

const EXPORT_RENDERABLE = new Set(["network", "kubernetes_namespace", "firewall", "load_balancer", "container_service", "static_site", "scheduled_job", "secret", "identity", "volume", "tls_certificate"]);

const byAddress = (a: { address: string }, b: { address: string }): number => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);

function partition(nodes: readonly ResourceNode[]): { render: ResourceNode[]; excluded: ExcludedNode[] } {
  const managed = nodes.filter((n) => n.provider === "zenith" && n.ownership === "managed").sort(byAddress);
  const render: ResourceNode[] = [];
  const excluded: ExcludedNode[] = [];
  const skip = (n: ResourceNode, reason: string) => excluded.push({ address: n.address, kind: n.kind, reason });
  for (const n of managed) {
    if (n.kind === "dns_record") skip(n, "DNS records are yours to create: point the host at your ingress controller's address");
    else if (n.kind === "dns_zone") skip(n, "DNS zones are not manifests");
    else if (n.kind === "postgres") skip(n, "the managed Postgres is an external service, not a manifest; connect your own Postgres (see README, Database)");
    else if (NOT_OFFERED[n.kind]) skip(n, NOT_OFFERED[n.kind]);
    else if (UNSUPPORTED[n.kind]) skip(n, UNSUPPORTED[n.kind]);
    else if (EXPORT_RENDERABLE.has(n.kind)) render.push(n);
    else skip(n, `${n.kind} has no Kubernetes manifest`);
  }
  // a firewall whose target was not exported has nothing to protect in the bundle
  const inBundle = new Set(render.map((n) => n.address));
  const kept: ResourceNode[] = [];
  for (const n of render) {
    if (n.kind === "firewall") {
      const target = isRecord(n.spec) && typeof n.spec.target === "string" ? n.spec.target : undefined;
      if (target === undefined || !inBundle.has(target)) {
        skip(n, "its target is not part of the bundle");
        continue;
      }
    }
    kept.push(n);
  }
  return { render: kept, excluded: excluded.sort(byAddress) };
}

/** Drop Zenith's ownership annotations; keep labels (selectors depend on them). */
function portable(obj: K8sObject): K8sObject {
  const clone = structuredClone(obj);
  const ann = clone.metadata.annotations;
  if (ann) {
    for (const k of Object.keys(ann)) if (k.startsWith("zenith.dev/")) delete ann[k];
    if (Object.keys(ann).length === 0) delete clone.metadata.annotations;
  }
  return clone;
}

const yaml = (o: unknown): string => dump(o, { sortKeys: true, noRefs: true, lineWidth: -1 });

const fileName = (index: number, o: K8sObject): string => `manifests/${String(index).padStart(2, "0")}-${o.kind.toLowerCase()}-${dnsLabelOf(o.metadata.name)}.yaml`;

function hostsOf(objects: readonly K8sObject[]): string[] {
  const hosts = new Set<string>();
  for (const o of objects) {
    if (o.kind !== "Ingress" || !isRecord(o.spec) || !Array.isArray(o.spec.rules)) continue;
    for (const r of o.spec.rules) if (isRecord(r) && typeof r.host === "string") hosts.add(r.host);
  }
  return [...hosts].sort();
}

function secretsOf(objects: readonly K8sObject[], environmentId: string, databaseAddresses: readonly string[]): ExportedSecret[] {
  const dbRefs = new Map(databaseAddresses.map((a) => [managedDatabaseConnectionRef(environmentId, a), a]));
  const out: ExportedSecret[] = [];
  for (const o of objects) {
    if (o.kind !== "Secret") continue;
    const reference = o.metadata.annotations?.[OWNERSHIP.secretRefAnnotation] ?? "unknown";
    const db = dbRefs.get(reference);
    out.push({ name: o.metadata.name, key: SECRET_KEY, reference, ...(db ? { note: `the connection string of ${db}; use YOUR Postgres' URL` } : {}) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function readme(i: { title: string; namespace: string; ingressClass: string; issuer: string; files: readonly ExportedFile[]; hosts: readonly string[]; excluded: readonly ExcludedNode[]; secrets: readonly ExportedSecret[]; notes: readonly string[]; hasDatabase: boolean }): string {
  const l: string[] = [];
  l.push(`# ${i.title}: Kubernetes export`);
  l.push("");
  l.push("This bundle is the same application your Zenith-managed environment runs, as plain Kubernetes manifests. It runs on any conformant cluster; nothing here needs Zenith, and nothing phones home.");
  l.push("");
  l.push("It was produced by Zenith's Kubernetes renderer. It has been generated, not applied to a cluster by Zenith: apply it to a test cluster first.");
  l.push("");
  l.push("## Prerequisites on your cluster");
  l.push("");
  l.push(`- Kubernetes with an ingress controller whose IngressClass is \`${i.ingressClass}\` (change \`ingressClassName\` in the Ingress files for another).`);
  l.push(`- cert-manager with a ClusterIssuer named \`${i.issuer}\` (the Certificates reference it; rename there if yours differs).`);
  l.push("- A CNI that enforces NetworkPolicy (the bundle includes default-deny ingress and explicit allow rules; without enforcement they do nothing).");
  l.push(`- The Pod Security Standard \`baseline\` is enforced on the namespace by the bundle and \`restricted\` is audited; the pods are written to pass \`restricted\`.`);
  l.push("");
  l.push("## Apply");
  l.push("");
  l.push("```");
  l.push("kubectl apply -k .");
  l.push("```");
  l.push("");
  l.push(`Objects go into the \`${i.namespace}\` namespace (the first manifest creates it). Files are numbered in apply order; \`kustomization.yaml\` lists them.`);
  l.push("");
  l.push("## Secrets you must create");
  l.push("");
  if (i.secrets.length === 0) {
    l.push("The app references no secrets.");
  } else {
    l.push("Zenith never exports secret values, and it stores none in manifests, so this bundle contains no Secret objects. Create each of these before the workloads start, with the value you hold:");
    l.push("");
    for (const s of i.secrets) {
      l.push(`- \`${s.name}\` (key \`${s.key}\`), logical reference \`${s.reference}\`${s.note ? `: ${s.note}` : ""}`);
      l.push(`  \`kubectl -n ${i.namespace} create secret generic ${s.name} --from-literal=${s.key}=<VALUE>\``);
    }
  }
  l.push("");
  l.push("## Hostnames and DNS");
  l.push("");
  if (i.hosts.length === 0) l.push("The app has no public routes.");
  else {
    l.push("The Ingress serves these hostnames, the ones your manifest asked for (the managed platform served its own managed hostnames instead):");
    l.push("");
    for (const h of i.hosts) l.push(`- \`${h}\``);
    l.push("");
    l.push("Create DNS records pointing each at your ingress controller's address, then cert-manager can issue the certificates.");
  }
  l.push("");
  l.push("## Database");
  l.push("");
  if (!i.hasDatabase) l.push("The app declares no Zenith-managed database.");
  else {
    l.push("The managed Postgres is an external service run for you by a managed-database provider; it is not part of this bundle, and Zenith never ran it in a cluster. To run the app elsewhere you need a Postgres of your own and the data in it.");
    l.push("");
    l.push("Honest limit: Zenith's secret store has no way to export a value, and the managed platform has no database dump/export operation yet. So today the connection string is not something you can read back, and moving the data needs a dump that Zenith does not provide. If you need your data out, ask the platform operator for a dump before you rely on this export. This is the one place the managed platform is not yet lock-in free.");
    l.push("");
    l.push("Once you have a database, create the connection Secret listed above with your own URL.");
  }
  l.push("");
  l.push("## Not in this bundle");
  l.push("");
  if (i.excluded.length === 0) l.push("Nothing was left out.");
  else for (const e of i.excluded) l.push(`- \`${e.address}\` (${e.kind}): ${e.reason}`);
  l.push("");
  l.push("Also not reproduced: the managed platform's tenant isolation (per-environment namespace with restricted Pod Security, default-deny with gateway-only ingress and constrained egress, plan quotas). Decide your own on your cluster.");
  if (i.notes.length > 0) {
    l.push("");
    l.push("## Renderer notes");
    l.push("");
    for (const n of i.notes) l.push(`- ${n}`);
  }
  l.push("");
  l.push("## Files");
  l.push("");
  for (const f of i.files) l.push(`- \`${f.path}\``);
  l.push("");
  return l.join("\n");
}

/** Build the export bundle. Throws `ZenithError("render_error")` only when the Kubernetes render itself refuses. */
export function exportKubernetesBundle(input: ExportInput): ExportBundle {
  const namespace = input.namespace ?? DEFAULT_NAMESPACE;
  if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(namespace)) throw new ZenithError("render_error", "The export namespace must be a DNS-1123 label.");
  const ingressClass = input.ingressClass ?? DEFAULT_INGRESS_CLASS;
  const issuer = input.clusterIssuer ?? DEFAULT_ISSUER;
  const { render, excluded } = partition(input.nodes);

  const views = render.map((n) => ({ ...n, spec: { ...(isRecord(n.spec) ? n.spec : {}), namespace } }));
  const rendered =
    views.length === 0
      ? { objects: [] as K8sObject[], notes: [] as string[] }
      : input.toolkit.renderGraph(views, {
          environmentId: input.environmentId,
          namespace,
          ingressControllerNamespace: "ingress-nginx",
          clusterIssuers: { dns01: issuer, http01: issuer },
          automountServiceAccountToken: false,
          resolveImage: (_node, artifact) => (artifact.type === "built" ? input.builtImages?.[artifact.pipeline] : undefined),
        });

  const secrets = secretsOf(rendered.objects, input.environmentId, input.nodes.filter((n) => n.kind === "postgres").map((n) => n.address));
  const exportable = rendered.objects.filter((o) => o.kind !== "Secret").map(portable);
  const ingressObjects = exportable.map((o) => (o.kind === "Ingress" && isRecord(o.spec) && o.spec.ingressClassName === undefined ? { ...o, spec: { ingressClassName: ingressClass, ...o.spec } } : o));
  const manifests: ExportedFile[] = ingressObjects.map((o, i) => ({ path: fileName(i, o), content: yaml(o) }));
  const hosts = hostsOf(ingressObjects);

  const kustomization: ExportedFile = {
    path: "kustomization.yaml",
    content: yaml({ apiVersion: "kustomize.config.k8s.io/v1beta1", kind: "Kustomization", resources: manifests.map((f) => f.path) }),
  };
  const hasDatabase = input.nodes.some((n) => n.kind === "postgres" && n.provider === "zenith" && n.ownership === "managed");
  const notes = [...rendered.notes];
  const listing = [...manifests, kustomization];
  const readmeFile: ExportedFile = {
    path: "README.md",
    content: readme({ title: input.title, namespace, ingressClass, issuer, files: [...listing, { path: "README.md", content: "" }].sort((a, b) => (a.path < b.path ? -1 : 1)), hosts, excluded, secrets, notes, hasDatabase }),
  };
  const files = [readmeFile, kustomization, ...manifests].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, digest: digest(files), namespace, hosts, excluded, secrets, notes };
}
