/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A fake Kubernetes API server (node:http) for the driver tests. It is a
 * CONTRACT fake, not a cluster: it implements exactly the endpoints the
 * drivers call and models just enough of the real behavior to make the
 * behavior we depend on testable:
 *
 *   - API discovery (`/api/v1`, `/apis/<g>/<v>`), which the generic object
 *     client needs before every call; CRD groups can be switched off.
 *   - GET / list (labelSelector, fieldSelector, limit + continue) / DELETE
 *     (uid preconditions) / PATCH for the kinds Zenith renders, plus pods,
 *     events, replicasets, pod logs and the deployments/scale subresource.
 *   - Server-side apply with per-manager ownership: a manager's applied config
 *     is remembered, the live object is the merge of every manager's config,
 *     a manager re-applying a config without a field it owned REMOVES it, a
 *     different manager owning a field with a different value is a 409
 *     `FieldManagerConflict` (no force), and `managedFields` is emitted in
 *     real FieldsV1 form (`f:` / `k:{}` / `.`).
 *   - A tiny Deployment controller: template hash, ReplicaSets with the
 *     `deployment.kubernetes.io/revision` annotation, reuse of an old
 *     ReplicaSet on rollback, generation/observedGeneration and status either
 *     "instant" (rolls out immediately) or "manual" (tests set the status).
 *   - Bearer-token auth, request recording, fault and latency injection.
 *
 * What it does NOT model: admission, validation, RBAC, real defaulting, watch,
 * garbage collection beyond deleting owned ReplicaSets, or any scheduler.
 * Anything proven only here is labeled `contract` evidence, never `real`.
 */
import http from "node:http";
import { createHash } from "node:crypto";

export type Plain = Record<string, any>;

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  contentType?: string;
  authorized: boolean;
  body?: any;
}

interface Rule {
  match: (r: RecordedRequest) => boolean;
  status: number;
  message: string;
  times: number;
  delayMs?: number;
}

interface ManagerEntry {
  operation: "Apply" | "Update";
  config: Plain;
}

interface Stored {
  apiVersion: string;
  kind: string;
  namespace?: string;
  name: string;
  base: Plain; // system-owned fields: uid, creationTimestamp, status, controller annotations
  managers: Map<string, ManagerEntry>;
  resourceVersion: number;
  generation: number;
  lastSpecJson: string;
}

interface ResourceDef {
  name: string;
  kind: string;
  namespaced: boolean;
}

const GROUPS: Record<string, ResourceDef[]> = {
  "v1": [
    { name: "namespaces", kind: "Namespace", namespaced: false },
    { name: "serviceaccounts", kind: "ServiceAccount", namespaced: true },
    { name: "secrets", kind: "Secret", namespaced: true },
    { name: "persistentvolumeclaims", kind: "PersistentVolumeClaim", namespaced: true },
    { name: "services", kind: "Service", namespaced: true },
    { name: "pods", kind: "Pod", namespaced: true },
    { name: "events", kind: "Event", namespaced: true },
  ],
  "apps/v1": [
    { name: "deployments", kind: "Deployment", namespaced: true },
    { name: "statefulsets", kind: "StatefulSet", namespaced: true },
    { name: "replicasets", kind: "ReplicaSet", namespaced: true },
  ],
  "batch/v1": [{ name: "cronjobs", kind: "CronJob", namespaced: true }],
  "networking.k8s.io/v1": [
    { name: "networkpolicies", kind: "NetworkPolicy", namespaced: true },
    { name: "ingresses", kind: "Ingress", namespaced: true },
  ],
  "autoscaling/v2": [{ name: "horizontalpodautoscalers", kind: "HorizontalPodAutoscaler", namespaced: true }],
  "cert-manager.io/v1": [{ name: "certificates", kind: "Certificate", namespaced: true }],
  "externaldns.k8s.io/v1alpha1": [{ name: "dnsendpoints", kind: "DNSEndpoint", namespaced: true }],
};
const CRD_GROUPS = new Set(["cert-manager.io/v1", "externaldns.k8s.io/v1alpha1"]);

/* ------------------------------- json helpers ------------------------------ */

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const isObj = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.entries(v as Plain)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
    .join(",")}}`;
}

/** The merge key of a list item, in Kubernetes' associative-list sense, or undefined for an atomic list. */
function mergeKey(item: unknown): Plain | undefined {
  if (!isObj(item)) return undefined;
  if (typeof item.containerPort === "number") return { containerPort: item.containerPort, protocol: item.protocol ?? "TCP" };
  if (typeof item.port === "number" && typeof item.targetPort !== "undefined") return { port: item.port, protocol: item.protocol ?? "TCP" };
  if (typeof item.mountPath === "string") return { mountPath: item.mountPath };
  if (typeof item.name === "string") return { name: item.name };
  return undefined;
}

const keyJson = (k: Plain) => JSON.stringify(Object.fromEntries(Object.entries(k).sort(([a], [b]) => (a < b ? -1 : 1))));

function isKeyedList(list: unknown[]): boolean {
  return list.length > 0 && list.every((i) => mergeKey(i) !== undefined);
}

function mergeInto(target: Plain, src: Plain): Plain {
  for (const [k, v] of Object.entries(src)) {
    const t = target[k];
    if (isObj(v) && isObj(t)) mergeInto(t, v);
    else if (Array.isArray(v) && Array.isArray(t) && isKeyedList(v) && isKeyedList(t)) {
      for (const item of v) {
        const key = keyJson(mergeKey(item)!);
        const hit = t.find((x: unknown) => keyJson(mergeKey(x)!) === key);
        if (hit && isObj(hit) && isObj(item)) mergeInto(hit, item);
        else t.push(clone(item));
      }
    } else target[k] = clone(v);
  }
  return target;
}

/* ---------------------------- ownership (fieldsV1) --------------------------- */

type Tok = { k: string; sel?: Plain };
interface Leaf {
  toks: Tok[];
  value: unknown;
}

function leaves(config: unknown, toks: Tok[] = [], out: Leaf[] = []): Leaf[] {
  if (isObj(config)) {
    for (const [k, v] of Object.entries(config)) {
      if (toks.length === 0 && (k === "apiVersion" || k === "kind")) continue;
      if (toks.length === 1 && toks[0].k === "metadata" && (k === "name" || k === "namespace")) continue;
      leaves(v, [...toks, { k }], out);
    }
    if (Object.keys(config).length === 0) out.push({ toks, value: {} });
    return out;
  }
  if (Array.isArray(config) && isKeyedList(config)) {
    const last = toks[toks.length - 1];
    for (const item of config) {
      const sel = mergeKey(item)!;
      const base = [...toks.slice(0, -1), { k: last.k, sel }];
      leaves(item, base, out);
    }
    return out;
  }
  out.push({ toks, value: config });
  return out;
}

const pathString = (toks: Tok[]) =>
  toks.map((t) => (t.sel ? `${t.k}[${Object.entries(t.sel).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(",")}]` : t.k)).join(".");

function removeLeaf(config: Plain, toks: Tok[]): void {
  let cur: any = config;
  for (let i = 0; i < toks.length - 1; i++) {
    const t = toks[i];
    let next = cur?.[t.k];
    if (t.sel && Array.isArray(next)) next = next.find((x: Plain) => Object.entries(t.sel!).every(([k, v]) => canonical(x[k]) === canonical(v)));
    cur = next;
    if (cur === undefined) return;
  }
  const last = toks[toks.length - 1];
  if (isObj(cur)) delete cur[last.k];
}

function toFieldsV1(v: unknown, top = true): Plain {
  const out: Plain = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (top && (k === "apiVersion" || k === "kind")) continue;
    let child: Plain = {};
    if (isObj(val)) {
      const sub = toFieldsV1(val, false);
      const filtered = top && k === "metadata" ? Object.fromEntries(Object.entries(sub).filter(([x]) => x !== "f:name" && x !== "f:namespace")) : sub;
      child = Object.keys(filtered).length > 0 ? { ".": {}, ...filtered } : {};
      if (top && k === "metadata" && Object.keys(filtered).length === 0) continue;
    } else if (Array.isArray(val) && isKeyedList(val)) {
      for (const item of val) {
        const sub = toFieldsV1(item, false);
        child[`k:${keyJson(mergeKey(item)!)}`] = { ".": {}, ...sub };
      }
    }
    out[`f:${k}`] = child;
  }
  return out;
}

/* --------------------------------- server ---------------------------------- */

export interface FakeK8sOptions {
  token?: string;
  /** serve the cert-manager / external-dns CRD groups (default true) */
  crds?: boolean;
  /** "instant": Deployments/StatefulSets report a finished rollout; "manual": tests set status */
  rollout?: "instant" | "manual";
}

export interface FakeK8s {
  url: string;
  token: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
  setRolloutMode(mode: "instant" | "manual"): void;
  setCrds(enabled: boolean): void;
  /** insert a live object as if another tool (manager `kubectl`, Update) created it */
  seed(obj: Plain, manager?: string): Plain;
  /** another manager changes fields (an Update), taking ownership of them */
  foreignUpdate(kind: string, namespace: string | undefined, name: string, manager: string, patch: Plain): void;
  get(kind: string, namespace: string | undefined, name: string): Plain | undefined;
  list(kind: string, namespace?: string): Plain[];
  remove(kind: string, namespace: string | undefined, name: string): void;
  /** set controller-owned status (e.g. to stall a rollout); merged into `status` */
  setStatus(kind: string, namespace: string, name: string, status: Plain): void;
  /** replace a Deployment's ReplicaSets' status etc. is not modeled; pods/events/logs are seeded */
  seedPod(pod: Plain): void;
  seedEvent(event: Plain): void;
  setLog(namespace: string, pod: string, text: string): void;
  /** fail matching requests with a Status error */
  inject(rule: { match: (r: RecordedRequest) => boolean; status: number; message: string; times?: number; delayMs?: number }): void;
  clearInjections(): void;
  /** requests that changed state (PATCH/DELETE/POST) */
  writes(): RecordedRequest[];
}

export async function startFakeK8s(options: FakeK8sOptions = {}): Promise<FakeK8s> {
  const token = options.token ?? "test-token-abcdefgh-1234";
  let rolloutMode = options.rollout ?? "instant";
  let crdsEnabled = options.crds ?? true;
  const store = new Map<string, Stored>();
  const requests: RecordedRequest[] = [];
  const rules: Rule[] = [];
  const logs = new Map<string, string>();
  let counter = 0;
  let rv = 0;

  const keyOf = (apiVersion: string, kind: string, ns: string | undefined, name: string) => `${apiVersion}|${kind}|${ns ?? ""}|${name}`;
  const defOf = (apiVersion: string, plural: string) => GROUPS[apiVersion]?.find((r) => r.name === plural);
  const defByKind = (kind: string) => {
    for (const [apiVersion, list] of Object.entries(GROUPS)) {
      const d = list.find((r) => r.kind === kind);
      if (d) return { apiVersion, ...d };
    }
    return undefined;
  };

  const status = (code: number, message: string, reason: string, details?: Plain) => ({
    code,
    body: { kind: "Status", apiVersion: "v1", metadata: {}, status: "Failure", message, reason, code, ...(details ? { details } : {}) },
  });

  /* ------------------------------- composition ------------------------------ */

  function defaults(o: Plain): void {
    if (o.kind === "Deployment") {
      o.spec ??= {};
      o.spec.replicas ??= 1;
      o.spec.revisionHistoryLimit ??= 10;
      o.spec.progressDeadlineSeconds ??= 600;
      const pod = o.spec.template?.spec;
      if (pod) {
        pod.restartPolicy ??= "Always";
        pod.dnsPolicy ??= "ClusterFirst";
        for (const c of pod.containers ?? []) c.imagePullPolicy ??= "IfNotPresent";
      }
    }
    if (o.kind === "StatefulSet") {
      o.spec ??= {};
      o.spec.replicas ??= 1;
    }
  }

  function compose(s: Stored): Plain {
    const obj: Plain = clone(s.base);
    obj.apiVersion = s.apiVersion;
    obj.kind = s.kind;
    obj.metadata ??= {};
    obj.metadata.name = s.name;
    if (s.namespace) obj.metadata.namespace = s.namespace;
    const fields: Plain[] = [];
    for (const [manager, entry] of s.managers) {
      mergeInto(obj, entry.config);
      fields.push({ manager, operation: entry.operation, apiVersion: s.apiVersion, time: "2026-01-01T00:00:00Z", fieldsType: "FieldsV1", fieldsV1: toFieldsV1(entry.config) });
    }
    obj.metadata.name = s.name;
    if (s.namespace) obj.metadata.namespace = s.namespace;
    defaults(obj);
    obj.metadata.resourceVersion = String(s.resourceVersion);
    obj.metadata.generation = s.generation;
    obj.metadata.managedFields = fields;
    return obj;
  }

  const specJson = (s: Stored) => canonical(compose(s).spec ?? null) + canonical(compose(s).data ?? null);

  /* ----------------------------- deployment controller ---------------------- */

  function templateHash(tpl: Plain): string {
    const t = clone(tpl);
    if (t.metadata?.labels) delete t.metadata.labels["pod-template-hash"];
    return createHash("sha256").update(canonical(t)).digest("hex").slice(0, 10);
  }

  function reconcileWorkload(s: Stored): void {
    if (s.kind === "StatefulSet") {
      const live = compose(s);
      const n = live.spec.replicas ?? 1;
      if (rolloutMode === "instant") {
        s.base.status = { observedGeneration: s.generation, replicas: n, readyReplicas: n, updatedReplicas: n, currentRevision: "rev-1", updateRevision: "rev-1" };
      } else s.base.status = { ...(s.base.status ?? {}), observedGeneration: s.generation };
      return;
    }
    if (s.kind !== "Deployment") return;
    const live = compose(s);
    const tpl = live.spec.template ?? {};
    const hash = templateHash(tpl);
    const desired: number = live.spec.replicas ?? 1;
    const sets = [...store.values()].filter((x) => x.kind === "ReplicaSet" && x.namespace === s.namespace && x.base.metadata?.ownerReferences?.[0]?.name === s.name);
    const revOf = (x: Stored) => Number(x.base.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0);
    const maxRev = sets.reduce((m, x) => Math.max(m, revOf(x)), 0);
    let current = sets.find((x) => x.name === `${s.name}-${hash}`);
    if (!current) {
      const podTemplate = clone(tpl);
      podTemplate.metadata ??= {};
      podTemplate.metadata.labels = { ...(podTemplate.metadata.labels ?? {}), "pod-template-hash": hash };
      podTemplate.metadata.creationTimestamp = null;
      current = {
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        namespace: s.namespace,
        name: `${s.name}-${hash}`,
        base: {
          metadata: {
            uid: `uid-${++counter}`,
            creationTimestamp: "2026-01-01T00:00:00Z",
            labels: { ...(live.spec.selector?.matchLabels ?? {}), "pod-template-hash": hash },
            annotations: { "deployment.kubernetes.io/revision": String(maxRev + 1) },
            ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: s.name, uid: s.base.metadata.uid, controller: true }],
          },
          spec: { replicas: desired, selector: { matchLabels: { ...(live.spec.selector?.matchLabels ?? {}), "pod-template-hash": hash } }, template: podTemplate },
          status: { replicas: desired },
        },
        managers: new Map(),
        resourceVersion: ++rv,
        generation: 1,
        lastSpecJson: "",
      };
      store.set(keyOf("apps/v1", "ReplicaSet", s.namespace, current.name), current);
    } else if (revOf(current) < maxRev) {
      current.base.metadata.annotations["deployment.kubernetes.io/revision"] = String(maxRev + 1);
    }
    current.base.spec.replicas = desired;
    for (const x of sets) if (x !== current) x.base.spec.replicas = 0;
    s.base.metadata.annotations = { ...(s.base.metadata.annotations ?? {}), "deployment.kubernetes.io/revision": current.base.metadata.annotations["deployment.kubernetes.io/revision"] };
    if (rolloutMode === "instant") {
      s.base.status = {
        observedGeneration: s.generation,
        replicas: desired,
        updatedReplicas: desired,
        readyReplicas: desired,
        availableReplicas: desired,
        conditions: [
          { type: "Available", status: "True", reason: "MinimumReplicasAvailable" },
          { type: "Progressing", status: "True", reason: "NewReplicaSetAvailable" },
        ],
      };
    } else {
      s.base.status = { ...(s.base.status ?? {}), observedGeneration: s.generation };
    }
  }

  /* --------------------------------- mutation ------------------------------- */

  function persist(s: Stored): void {
    const json = specJson(s);
    if (json !== s.lastSpecJson) {
      s.generation = s.lastSpecJson === "" ? 1 : s.generation + 1;
      s.lastSpecJson = json;
    }
    reconcileWorkload(s);
    s.resourceVersion = ++rv;
  }

  function newStored(apiVersion: string, kind: string, namespace: string | undefined, name: string): Stored {
    return {
      apiVersion,
      kind,
      namespace,
      name,
      base: { metadata: { uid: `uid-${++counter}`, creationTimestamp: "2026-01-01T00:00:00Z" } },
      managers: new Map(),
      resourceVersion: 0,
      generation: 1,
      lastSpecJson: "",
    };
  }

  function conflictsFor(s: Stored, manager: string, config: Plain): { field: string; manager: string }[] {
    const mine = leaves(config);
    const out: { field: string; manager: string }[] = [];
    for (const [other, entry] of s.managers) {
      if (other === manager) continue;
      const theirs = new Map(leaves(entry.config).map((l) => [pathString(l.toks), l.value]));
      for (const l of mine) {
        const p = pathString(l.toks);
        if (theirs.has(p) && canonical(theirs.get(p)) !== canonical(l.value)) out.push({ field: `.${p}`, manager: other });
      }
    }
    return out;
  }

  function takeOwnership(s: Stored, manager: string, config: Plain, conflicts: { field: string; manager: string }[]): void {
    const fields = new Set(conflicts.map((c) => c.field.slice(1)));
    for (const [other, entry] of s.managers) {
      if (other === manager) continue;
      for (const l of leaves(entry.config)) if (fields.has(pathString(l.toks))) removeLeaf(entry.config, l.toks);
    }
    void config;
  }

  /** Apply (SSA) or merge-patch; returns the resulting live object, or an error response. */
  function mutate(
    apiVersion: string,
    def: ResourceDef,
    ns: string | undefined,
    name: string,
    body: Plain,
    q: { manager?: string; force: boolean; dryRun: boolean; apply: boolean }
  ): { code: number; body: Plain } {
    const key = keyOf(apiVersion, def.kind, ns, name);
    const existing = store.get(key);
    if (q.apply) {
      if (!q.manager) return status(400, "PatchOptions.meta.k8s.io \"\" is invalid: fieldManager: Required value: is required for apply patch", "BadRequest");
      if (body.kind !== def.kind || body.apiVersion !== apiVersion) return status(400, `the API version in the data (${body.apiVersion}) does not match the expected API version (${apiVersion})`, "BadRequest");
      if (body.metadata?.name !== name) return status(400, "the name of the object does not match the name on the URL", "BadRequest");
    }
    const s = existing ?? newStored(apiVersion, def.kind, ns, name);
    const working: Stored = existing
      ? { ...s, managers: new Map([...s.managers].map(([k, v]) => [k, { operation: v.operation, config: clone(v.config) }])), base: clone(s.base) }
      : s;
    const manager = q.manager ?? "unknown";
    const config = clone(body);
    if (q.apply) {
      const conflicts = conflictsFor(working, manager, config);
      if (conflicts.length > 0 && !q.force) {
        return status(409, `Apply failed with ${conflicts.length} conflict(s): ${conflicts.map((c) => `conflict with "${c.manager}": ${c.field}`).join("; ")}`, "Conflict", {
          name,
          kind: def.kind,
          causes: conflicts.map((c) => ({ reason: "FieldManagerConflict", message: `conflict with "${c.manager}" using ${apiVersion}: ${c.field}`, field: c.field })),
        });
      }
      if (conflicts.length > 0) takeOwnership(working, manager, config, conflicts);
      working.managers.set(manager, { operation: "Apply", config });
    } else {
      // merge-patch: an Update by `manager`; takes the patched fields from everyone else
      const patchLeaves = leaves(config);
      for (const [other, entry] of working.managers) {
        if (other === manager) continue;
        for (const l of leaves(entry.config)) if (patchLeaves.some((p) => pathString(p.toks) === pathString(l.toks))) removeLeaf(entry.config, l.toks);
      }
      const prior = working.managers.get(manager);
      const merged = prior ? mergeInto(clone(prior.config), config) : config;
      working.managers.set(manager, { operation: "Update", config: merged });
    }
    const before = existing ? canonical(compose(existing)) : "";
    if (q.dryRun) {
      const probe: Stored = { ...working, resourceVersion: existing?.resourceVersion ?? 0, generation: working.generation };
      if (!existing) probe.base = clone(probe.base);
      return { code: existing ? 200 : 201, body: compose(probe) };
    }
    // commit
    if (existing) {
      existing.managers = working.managers;
      existing.base = working.base;
    } else store.set(key, working);
    const target = existing ?? working;
    if (!existing || canonical(compose(target)) !== before) persist(target);
    return { code: existing ? 200 : 201, body: compose(target) };
  }

  /* ---------------------------------- http ---------------------------------- */

  const logKey = (ns: string, pod: string) => `${ns}/${pod}`;

  function matchesSelector(obj: Plain, selector: string | undefined): boolean {
    if (!selector) return true;
    return selector.split(",").every((term) => {
      const [k, v] = term.split("=");
      return obj.metadata?.labels?.[k] === v;
    });
  }

  function matchesFieldSelector(obj: Plain, selector: string | undefined): boolean {
    if (!selector) return true;
    return selector.split(",").every((term) => {
      const [k, v] = term.split("=");
      const value = k.split(".").reduce((acc: any, part) => acc?.[part], obj);
      return String(value) === v;
    });
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const query = Object.fromEntries(url.searchParams.entries());
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query,
        contentType: req.headers["content-type"],
        authorized: req.headers.authorization === `Bearer ${token}`,
        body,
      };
      requests.push(recorded);
      const send = (code: number, payload: unknown, contentType = "application/json") => {
        res.writeHead(code, { "content-type": contentType });
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };
      const sendStatus = (s: { code: number; body: Plain }) => send(s.code, s.body);

      if (!recorded.authorized) return sendStatus(status(401, "Unauthorized", "Unauthorized"));

      const rule = rules.find((r) => r.times !== 0 && r.match(recorded));
      if (rule) {
        if (rule.times > 0) rule.times--;
        if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
        if (rule.status >= 400) return sendStatus(status(rule.status, rule.message, rule.status === 403 ? "Forbidden" : "InternalError"));
      }

      const m = /^\/(api\/v1|apis\/[^/]+\/[^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (!m) return sendStatus(status(404, "the server could not find the requested resource", "NotFound"));
      const apiVersion = m[1] === "api/v1" ? "v1" : m[1].slice("apis/".length);
      const rest = (m[2] ?? "").split("/").filter(Boolean).map(decodeURIComponent);

      // discovery
      if (rest.length === 0) {
        const defs = GROUPS[apiVersion];
        if (!defs || (CRD_GROUPS.has(apiVersion) && !crdsEnabled)) return sendStatus(status(404, "the server could not find the requested resource", "NotFound"));
        return send(200, {
          kind: "APIResourceList",
          apiVersion: "v1",
          groupVersion: apiVersion,
          resources: defs.map((d) => ({ name: d.name, singularName: "", namespaced: d.namespaced, kind: d.kind, verbs: ["get", "list", "patch", "delete"] })),
        });
      }
      if (!GROUPS[apiVersion] || (CRD_GROUPS.has(apiVersion) && !crdsEnabled)) return sendStatus(status(404, "the server could not find the requested resource", "NotFound"));

      let ns: string | undefined;
      let plural: string;
      let name: string | undefined;
      let sub: string | undefined;
      if (rest[0] === "namespaces" && rest.length >= 3) {
        ns = rest[1];
        plural = rest[2];
        name = rest[3];
        sub = rest[4];
      } else {
        plural = rest[0];
        name = rest[1];
        sub = rest[2];
      }
      const def = defOf(apiVersion, plural);
      if (!def) return sendStatus(status(404, "the server could not find the requested resource", "NotFound"));

      const method = recorded.method;
      // collection
      if (name === undefined) {
        if (method !== "GET") return sendStatus(status(405, "method not allowed", "MethodNotAllowed"));
        const all = [...store.values()]
          .filter((s) => s.apiVersion === apiVersion && s.kind === def.kind && (!ns || s.namespace === ns))
          .map(compose)
          .filter((o) => matchesSelector(o, query.labelSelector) && matchesFieldSelector(o, query.fieldSelector))
          .sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : 1));
        const limit = query.limit ? Number(query.limit) : all.length;
        const offset = query.continue ? Number(query.continue) : 0;
        const page = all.slice(offset, offset + limit);
        const next = offset + limit < all.length ? String(offset + limit) : undefined;
        return send(200, { kind: `${def.kind}List`, apiVersion, metadata: { resourceVersion: String(rv), ...(next ? { continue: next } : {}) }, items: page });
      }

      const key = keyOf(apiVersion, def.kind, ns, name);

      if (sub === "log" && def.kind === "Pod") {
        if (method !== "GET") return sendStatus(status(405, "method not allowed", "MethodNotAllowed"));
        const pod = store.get(key);
        if (!pod) return sendStatus(status(404, `pods "${name}" not found`, "NotFound", { name, kind: "pods" }));
        let text = logs.get(logKey(ns ?? "", name)) ?? "";
        const tail = query.tailLines ? Number(query.tailLines) : undefined;
        if (tail !== undefined) text = text.split("\n").slice(-tail).join("\n");
        if (query.limitBytes) text = text.slice(0, Number(query.limitBytes));
        return send(200, text, "text/plain");
      }

      if (sub === "scale" && def.kind === "Deployment") {
        const s = store.get(key);
        if (!s) return sendStatus(status(404, `deployments.apps "${name}" not found`, "NotFound", { name, kind: "deployments" }));
        const live = compose(s);
        const scale = () => ({ kind: "Scale", apiVersion: "autoscaling/v1", metadata: { name, namespace: ns, resourceVersion: String(s.resourceVersion) }, spec: { replicas: live.spec.replicas }, status: { replicas: live.spec.replicas, selector: "" } });
        if (method === "GET") return send(200, scale());
        if (method === "PATCH") {
          const r = mutate(apiVersion, def, ns, name, { spec: { replicas: body?.spec?.replicas } }, { manager: query.fieldManager, force: false, dryRun: query.dryRun === "All", apply: false });
          if (r.code >= 400) return sendStatus(r);
          const after = compose(store.get(key)!);
          return send(200, { kind: "Scale", apiVersion: "autoscaling/v1", metadata: { name, namespace: ns }, spec: { replicas: after.spec.replicas }, status: { replicas: after.spec.replicas, selector: "" } });
        }
        return sendStatus(status(405, "method not allowed", "MethodNotAllowed"));
      }

      if (method === "GET") {
        const s = store.get(key);
        if (!s) return sendStatus(status(404, `${def.name} "${name}" not found`, "NotFound", { name, kind: def.name }));
        return send(200, compose(s));
      }
      if (method === "PATCH") {
        const isApply = (recorded.contentType ?? "").startsWith("application/apply-patch");
        if (!isApply && !(recorded.contentType ?? "").startsWith("application/merge-patch")) return sendStatus(status(415, "unsupported patch type", "UnsupportedMediaType"));
        const r = mutate(apiVersion, def, ns, name, body, { manager: query.fieldManager, force: query.force === "true", dryRun: query.dryRun === "All", apply: isApply });
        return sendStatus(r);
      }
      if (method === "DELETE") {
        const s = store.get(key);
        if (!s) return sendStatus(status(404, `${def.name} "${name}" not found`, "NotFound", { name, kind: def.name }));
        const pre = body?.preconditions?.uid;
        if (pre && pre !== s.base.metadata.uid) return sendStatus(status(409, `Precondition failed: UID in precondition: ${pre}, UID in object meta: ${s.base.metadata.uid}`, "Conflict"));
        store.delete(key);
        if (def.kind === "Deployment") {
          for (const [k, x] of [...store]) if (x.kind === "ReplicaSet" && x.namespace === ns && x.base.metadata?.ownerReferences?.[0]?.name === name) store.delete(k);
        }
        return send(200, { kind: "Status", apiVersion: "v1", status: "Success", details: { name, kind: def.name, uid: s.base.metadata.uid } });
      }
      return sendStatus(status(405, "method not allowed", "MethodNotAllowed"));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  const find = (kind: string, ns: string | undefined, name: string) => {
    const d = defByKind(kind);
    return d ? store.get(keyOf(d.apiVersion, kind, ns, name)) : undefined;
  };

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
    setRolloutMode: (m) => { rolloutMode = m; },
    setCrds: (e) => { crdsEnabled = e; },
    seed(obj, manager = "kubectl") {
      const d = defByKind(obj.kind);
      if (!d) throw new Error(`fake: unknown kind ${obj.kind}`);
      const s = newStored(d.apiVersion, obj.kind, obj.metadata?.namespace, obj.metadata.name);
      s.managers.set(manager, { operation: "Update", config: clone(obj) });
      store.set(keyOf(d.apiVersion, obj.kind, s.namespace, s.name), s);
      persist(s);
      return compose(s);
    },
    foreignUpdate(kind, namespace, name, manager, patch) {
      const s = find(kind, namespace, name);
      if (!s) throw new Error(`fake: ${kind}/${name} not found`);
      const d = defByKind(kind)!;
      const r = mutate(d.apiVersion, d, namespace, name, patch, { manager, force: false, dryRun: false, apply: false });
      if (r.code >= 400) throw new Error(`fake: foreign update failed ${r.code}`);
    },
    get: (kind, namespace, name) => { const s = find(kind, namespace, name); return s ? compose(s) : undefined; },
    list: (kind, namespace) => [...store.values()].filter((s) => s.kind === kind && (!namespace || s.namespace === namespace)).map(compose),
    remove(kind, namespace, name) { const d = defByKind(kind)!; store.delete(keyOf(d.apiVersion, kind, namespace, name)); },
    setStatus(kind, namespace, name, st) {
      const s = find(kind, namespace, name);
      if (!s) throw new Error(`fake: ${kind}/${name} not found`);
      s.base.status = { ...(s.base.status ?? {}), ...st };
      s.resourceVersion = ++rv;
    },
    seedPod(pod) {
      const s = newStored("v1", "Pod", pod.metadata.namespace, pod.metadata.name);
      s.base = clone(pod);
      s.base.metadata.uid ??= `uid-${++counter}`;
      store.set(keyOf("v1", "Pod", s.namespace, s.name), s);
      s.resourceVersion = ++rv;
    },
    seedEvent(event) {
      const s = newStored("v1", "Event", event.metadata.namespace, event.metadata.name);
      s.base = clone(event);
      s.base.metadata.uid ??= `uid-${++counter}`;
      store.set(keyOf("v1", "Event", s.namespace, s.name), s);
      s.resourceVersion = ++rv;
    },
    setLog: (namespace, pod, text) => { logs.set(logKey(namespace, pod), text); },
    inject: (rule) => { rules.push({ times: -1, ...rule }); },
    clearInjections: () => { rules.length = 0; },
    writes: () => requests.filter((r) => ["PATCH", "DELETE", "POST", "PUT"].includes(r.method)),
  };
}
