/** Real Mac transports. Importing this module never opens credentials or constructs a cloud client. */
import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import https from "node:https";
import { load as yamlLoad } from "js-yaml";
import type { Target } from "./plan";
import type { Response, Transport } from "./runner";
import type { Scope } from "../../../release/scope";
import { verifyMixedEvidence } from "../../mixed-evidence";
import { mixedTraffic, connectivity } from "../mixed/probes";

type Env = Readonly<Record<string, string | undefined>>;
export function privateFile(ref: string, env: Env): string {
  const file = env[ref];
  if (!file || !path.isAbsolute(file)) throw new Error("Credential reference must name an absolute private FILE");
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("Credential file must be a bounded, private regular file");
  return file;
}
function credential(t: Target, env: Env): string {
  const value = readFileSync(privateFile(t.credentialRef!, env), "utf8").trim();
  if (!value || /[\r\n]/.test(value)) throw new Error("Credential file is empty or not a single header value");
  return value;
}
async function jsonFetch(url: URL, init: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(20000) });
  const reader = response.body?.getReader();
  const chunks: Buffer[] = []; let total = 0;
  if (reader) try {
    for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.length; if (total > 2 * 1024 * 1024) throw new Error("Bounded response exceeded"); chunks.push(Buffer.from(part.value)); }
  } finally { await reader.cancel().catch(() => undefined); }
  const raw = Buffer.concat(chunks).toString("utf8");
  return { status: response.status, body: raw ? JSON.parse(raw) as unknown : null };
}
interface KubeFile { contexts: { name: string; context: { cluster: string; user: string } }[]; clusters: { name: string; cluster: { server: string; "insecure-skip-tls-verify"?: boolean; "proxy-url"?: string; "certificate-authority-data"?: string } }[]; users: { name: string; user: Record<string, unknown> }[] }
function kubeMaterial(t: Target, env: Env) {
  const file = privateFile(t.credentialRef!, env);
  const cfg = yamlLoad(readFileSync(file, "utf8")) as KubeFile;
  const context = cfg.contexts?.find(c => c.name === t.context);
  const cluster = cfg.clusters?.find(c => c.name === context?.context.cluster)?.cluster;
  const user = cfg.users?.find(u => u.name === context?.context.user)?.user;
  if (!cluster || !user || !t.origin || cluster.server !== t.origin || !cluster.server.startsWith("https://") || cluster["insecure-skip-tls-verify"] || cluster["proxy-url"] || user.exec || user["auth-provider"] || user["tokenFile"]) throw new Error("Kubeconfig must bind the approved server/context with static credentials and TLS verification; credential plugins are refused");
  if (!user.token && !(user["client-certificate-data"] && user["client-key-data"])) throw new Error("Use a static temporary token or embedded client certificate, never an ambient credential plugin");
  return { server: cluster.server, ca: cluster["certificate-authority-data"] ? Buffer.from(cluster["certificate-authority-data"], "base64") : undefined,
    token: typeof user.token === "string" ? user.token : undefined,
    cert: typeof user["client-certificate-data"] === "string" ? Buffer.from(user["client-certificate-data"], "base64") : undefined,
    key: typeof user["client-key-data"] === "string" ? Buffer.from(user["client-key-data"], "base64") : undefined };
}
function kubeRequest(t: Target, env: Env, pathname: string, method = "GET", body?: unknown): Promise<Response> {
  const material = kubeMaterial(t, env);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { accept: "application/json", ...(material.token ? { authorization: `Bearer ${material.token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) };
    const req = https.request(new URL(pathname, material.server), { method, headers, ca: material.ca, cert: material.cert, key: material.key, rejectUnauthorized: true }, res => {
      const parts: Buffer[] = []; let bytes = 0;
      res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) req.destroy(new Error("Bounded Kubernetes response exceeded")); else parts.push(chunk); });
      res.on("end", () => { clearTimeout(timer); try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString("utf8")) }); } catch { reject(new Error("Kubernetes response was not JSON")); } });
      res.on("error", () => { clearTimeout(timer); reject(new Error("Kubernetes response failed")); });
    });
    const timer = setTimeout(() => req.destroy(new Error("Kubernetes request timed out")), 20000);
    req.on("error", () => { clearTimeout(timer); reject(new Error("Kubernetes request failed")); });
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

/** Tag spellings differ by provider; the owner must stamp these during ordinary provisioning.
 * Inventory is deliberately limited to tag-indexed AWS/GCP/Azure resources and labelled K8s objects. */
export function realTransport(env: Env, runId: string, targets: readonly Target[], _scope?: Scope): Transport {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0" || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS verification bypass is forbidden");
  return { async send(q, t, beforeRead, ownership): Promise<Response> {
    if (q.kind === "mixed_traffic") return { status: 200, body: await mixedTraffic(q, t, targets, env, runId, beforeRead) };
    if (q.kind === "connectivity") return { status: 200, body: await connectivity(q, env, beforeRead) };
    if (q.kind === "mixed_evidence") {
      const headers: Record<string, string> = { accept: "application/json", "x-zenith-workspace": t.workspaceId! };
      if (t.auth === "browser") headers.cookie = credential(t, env); else headers.authorization = `Bearer ${credential(t, env)}`;
      const response = await jsonFetch(new URL(q.path, t.origin), { headers });
      return { status: response.status, body: { ok: response.status === 200 && verifyMixedEvidence(response.body).ok } };
    }
    if (q.kind === "http") {
      const headers: Record<string, string> = { accept: "application/json" };
      if (t.auth === "bearer") headers.authorization = `Bearer ${credential(t, env)}`;
      if (t.auth === "browser") { headers.cookie = credential(t, env); headers.origin = t.origin!; headers["sec-fetch-site"] = "same-origin"; }
      if (t.workspaceId) headers["x-zenith-workspace"] = t.workspaceId;
      if (q.body) headers["content-type"] = "application/json";
      return jsonFetch(new URL(q.path, t.origin), { method: q.method, headers, body: q.body ? JSON.stringify(q.body) : undefined });
    }
    if (t.kind === "kubernetes") {
      if (q.kind === "kubernetes") {
        const kinds = { namespace: ["/api/v1", "namespaces"], deployment: ["/apis/apps/v1", "deployments"], pods: ["/api/v1", "pods"], resourcequota: ["/api/v1", "resourcequotas"], networkpolicy: ["/apis/networking.k8s.io/v1", "networkpolicies"], httproute: ["/apis/gateway.networking.k8s.io/v1", "httproutes"], certificate: ["/apis/cert-manager.io/v1", "certificates"], persistentvolumeclaim: ["/api/v1", "persistentvolumeclaims"], job: ["/apis/batch/v1", "jobs"] };
        const [api, plural] = kinds[q.resource];
        if (q.resource !== "namespace" && !q.namespace) throw new Error("Namespaced read requires its exact namespace");
        return kubeRequest(t, env, `${api}${q.namespace ? `/namespaces/${encodeURIComponent(q.namespace)}` : ""}/${plural}/${encodeURIComponent(q.name)}`);
      }
      if (q.kind === "delete_namespace") {
        const metadata = (ownership as { metadata?: { uid?: string; resourceVersion?: string; name?: string } })?.metadata;
        if (!metadata?.uid || !metadata.resourceVersion || metadata.name !== q.name) throw new Error("Namespace deletion requires the freshly read UID/resourceVersion");
        return kubeRequest(t, env, `/api/v1/namespaces/${encodeURIComponent(q.name)}`, "DELETE", { apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: metadata.uid, resourceVersion: metadata.resourceVersion } });
      }
      if (q.kind === "scale_deployment") {
        const metadata = (ownership as { metadata?: { uid?: string; resourceVersion?: string; name?: string; namespace?: string } })?.metadata;
        if (!metadata?.uid || !metadata.resourceVersion || metadata.name !== q.name || metadata.namespace !== q.namespace) throw new Error("Scaling requires the freshly read Deployment identity");
        return kubeRequest(t, env, `/apis/apps/v1/namespaces/${encodeURIComponent(q.namespace)}/deployments/${encodeURIComponent(q.name)}/scale`, "PUT", { apiVersion: "autoscaling/v1", kind: "Scale", metadata: { uid: metadata.uid, resourceVersion: metadata.resourceVersion, name: q.name, namespace: q.namespace }, spec: { replicas: q.replicas } });
      }
      const found: unknown[] = [];
      for (const endpoint of ["/api/v1/namespaces", "/api/v1/persistentvolumes", "/apis/rbac.authorization.k8s.io/v1/clusterroles", "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings"]) {
        beforeRead(); const url = new URL(endpoint, t.origin); url.searchParams.set("labelSelector", `zenith.dev/live-run=${runId}`);
        const objects = await kubeRequest(t, env, `${url.pathname}${url.search}`);
        const body = objects.body as { items?: unknown[]; metadata?: { continue?: string } };
        if (objects.status !== 200 || !Array.isArray(body.items) || body.metadata?.continue) throw new Error("Unreadable or incomplete cluster inventory");
        found.push(...body.items);
      }
      return { status: 200, body: found };
    }
    if (q.kind !== "inventory") throw new Error("Unsupported transport");
    if (t.kind === "aws") {
      const material = JSON.parse(readFileSync(privateFile(t.credentialRef!, env), "utf8")) as { accessKeyId: string; secretAccessKey: string; sessionToken: string };
      if (!material.accessKeyId || !material.secretAccessKey || !material.sessionToken) throw new Error("Inventory requires explicit temporary AWS credentials from a file");
      const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
      const { ResourceGroupsTaggingAPIClient, GetResourcesCommand } = await import("@aws-sdk/client-resource-groups-tagging-api");
      if (!/^(us|eu|ap|sa|ca|me|af|il)-[a-z]+-\d$/.test(t.region)) throw new Error("L3 AWS inventory supports reviewed commercial regions only; sovereign inventory joins L1");
      const options = { region: t.region, credentials: material, maxAttempts: 1, requestHandler: { requestTimeout: 20000 } };
      const sts = new STSClient({ ...options, endpoint: `https://sts.${t.region}.amazonaws.com` }); const api = new ResourceGroupsTaggingAPIClient({ ...options, endpoint: `https://tagging.${t.region}.amazonaws.com` });
      try {
        beforeRead(); if ((await sts.send(new GetCallerIdentityCommand({}))).Account !== t.account) throw new Error("AWS sandbox account mismatch");
        const found: unknown[] = []; let token: string | undefined;
        for (let page = 0; page < 100; page++) {
          beforeRead(); const result = await api.send(new GetResourcesCommand({ TagFilters: [{ Key: "zenith:live-run", Values: [runId] }], ResourcesPerPage: 100, PaginationToken: token }));
          found.push(...result.ResourceTagMappingList ?? []); token = result.PaginationToken;
          if (!token) return { status: 200, body: found };
        }
        throw new Error("AWS inventory pagination bound exceeded");
      } finally { sts.destroy(); api.destroy(); }
    }
    if (t.kind === "gcp" || t.kind === "azure") {
      const origin = t.kind === "gcp" ? "https://cloudasset.googleapis.com" : "https://management.azure.com";
      let url = new URL(`/subscriptions/${t.account}/resources?api-version=2021-04-01`, origin);
      if (t.kind === "gcp") { url = new URL(`/v1/projects/${t.account}:searchAllResources`, origin); url.searchParams.set("query", `labels.zenith_live_run=${runId}`); url.searchParams.set("pageSize", "500"); }
      else url.searchParams.set("$filter", `tagName eq 'zenith:live-run' and tagValue eq '${runId}'`);
      const found: unknown[] = [];
      for (let page = 0; page < 100; page++) {
        if (url.origin !== origin || !url.pathname.startsWith(t.kind === "gcp" ? `/v1/projects/${t.account}:` : `/subscriptions/${t.account}/`)) throw new Error("Inventory pagination escaped the approved account");
        beforeRead(); const result = await jsonFetch(url, { headers: { authorization: `Bearer ${credential(t, env)}` } });
        if (result.status !== 200) throw new Error("Cloud inventory failed");
        const body = result.body as { results?: unknown[]; value?: unknown[]; nextPageToken?: string; nextLink?: string };
        const items = t.kind === "gcp" ? body.results : body.value;
        // GCP omits results on an empty page; Azure always returns value.
        if (items !== undefined && !Array.isArray(items) || t.kind === "azure" && items === undefined) throw new Error("Cloud inventory shape changed");
        found.push(...items ?? []);
        if (t.kind === "gcp" && body.nextPageToken) url.searchParams.set("pageToken", body.nextPageToken);
        else if (t.kind === "azure" && body.nextLink) url = new URL(body.nextLink);
        else return { status: 200, body: found };
      }
      throw new Error("Cloud inventory pagination bound exceeded");
    }
    throw new Error("No inventory adapter for this provider; cannot claim zero leaks");
  } };
}
