/**
 * Local HTTP contract fake for the production TLS adapter. Models discovery,
 * atomic create, resourceVersion updates and conditional delete. No admission,
 * RBAC, certificate controller, garbage collection or public DNS/TLS exists here.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { K8sObject } from "@/lib/providers/zenith/k8s-port";

export interface TlsRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: Record<string, unknown>;
  contentType?: string;
}

const resources = {
  "v1": [{ name: "secrets", kind: "Secret", namespaced: true }],
  "cert-manager.io/v1": [{ name: "certificates", kind: "Certificate", namespaced: true }],
  "gateway.networking.k8s.io/v1": [{ name: "gateways", kind: "Gateway", namespaced: true }],
} as const;

export async function startTlsApi() {
  const store = new Map<string, K8sObject>();
  const requests: TlsRequest[] = [];
  const token = "contract-tls-operator-token";
  const unavailable = new Set<string>();
  const faults: { method: string; kind: string; status: number; message: string; delay?: number }[] = [];
  let beforeMutation: ((method: string, object: K8sObject) => void) | undefined;
  let sequence = 0;
  const key = (obj: K8sObject) => `${obj.kind}/${obj.metadata.namespace}/${obj.metadata.name}`;
  const seed = (object: K8sObject) => {
    const existing = store.get(key(object));
    const version = String(++sequence);
    const live = structuredClone({ ...object, metadata: { ...object.metadata, uid: existing?.metadata.uid ?? `uid-${version}`, resourceVersion: version } });
    store.set(key(object), live);
    return live;
  };
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const fail = (status: number, message: string) => reply(status, { apiVersion: "v1", kind: "Status", status: "Failure", message, code: status });
    try {
      const url = new URL(req.url!, "http://127.0.0.1");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : undefined;
      const request: TlsRequest = { method: req.method!, path: url.pathname, query: Object.fromEntries(url.searchParams), body, contentType: req.headers["content-type"] };
      requests.push(request);
      if (req.headers.authorization !== `Bearer ${token}`) { fail(401, "Contract token rejected."); return; }
      const group = Object.keys(resources).find((g) => url.pathname === (g === "v1" ? "/api/v1" : `/apis/${g}`));
      if (group) {
        if (unavailable.has(group)) { fail(404, "CRD unavailable."); return; }
        reply(200, { apiVersion: "v1", kind: "APIResourceList", groupVersion: group, resources: resources[group as keyof typeof resources] });
        return;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      const index = parts.indexOf("namespaces");
      const namespace = parts[index + 1];
      const resource = parts[index + 2];
      const definition = Object.entries(resources).flatMap(([apiVersion, defs]) => defs.map((def) => ({ ...def, apiVersion }))).find((def) => def.name === resource);
      if (index < 0 || !definition || unavailable.has(definition.apiVersion)) { fail(404, "Resource unavailable."); return; }
      const name = parts[index + 3] ?? (body?.metadata as { name?: string } | undefined)?.name;
      if (!name) { fail(400, "Name required."); return; }
      const stub: K8sObject = { apiVersion: definition.apiVersion, kind: definition.kind, metadata: { name, namespace } };
      const faultIndex = faults.findIndex((f) => f.method === req.method && f.kind === definition.kind);
      if (faultIndex >= 0) {
        const fault = faults.splice(faultIndex, 1)[0];
        if (fault.delay) await new Promise<void>((resolve) => setTimeout(resolve, fault.delay));
        fail(fault.status, fault.message); return;
      }
      if (req.method === "GET") {
        const live = store.get(key(stub));
        if (live) reply(200, live); else fail(404, "Absent.");
        return;
      }
      beforeMutation?.(req.method!, stub);
      const live = store.get(key(stub));
      if (req.method === "POST" || req.method === "PATCH") {
        if (req.method === "POST" && live) { fail(409, "Already exists."); return; }
        const wanted = body as unknown as K8sObject;
        if (req.method === "PATCH" && (!live || wanted.metadata.resourceVersion !== live.metadata.resourceVersion)) { fail(409, "resourceVersion changed."); return; }
        const next = { ...wanted, metadata: { ...wanted.metadata, uid: live?.metadata.uid ?? "dry-uid", resourceVersion: "dry-version" } };
        reply(req.method === "POST" ? 201 : 200, request.query.dryRun === "All" ? next : seed(wanted));
        return;
      }
      if (req.method === "DELETE") {
        if (!live) { fail(404, "Absent."); return; }
        const preconditions = body?.preconditions as { uid?: string; resourceVersion?: string } | undefined;
        if (preconditions?.uid !== live.metadata.uid || preconditions?.resourceVersion !== live.metadata.resourceVersion) { fail(409, "Delete precondition changed."); return; }
        if (request.query.dryRun !== "All") store.delete(key(stub));
        reply(200, { apiVersion: "v1", kind: "Status", status: "Success" }); return;
      }
      fail(405, "Unsupported method.");
    } catch { fail(500, "Contract server failed."); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token, store, requests, seed, unavailable, faults,
    beforeMutation(callback: typeof beforeMutation) { beforeMutation = callback; },
    writes: () => requests.filter((r) => ["POST", "PATCH", "DELETE"].includes(r.method)),
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }),
  };
}
