/**
 * The Kubernetes API client a driver call works through: typed APIs plus the
 * generic object API (server-side apply), bound to ONE session and ONE abort
 * signal, with the namespace allowlist enforced and every failure normalized
 * to a `K8sError` whose message carries no secret value and no token.
 *
 * Honest limit: abort cancels the in-flight HTTP request (the signal is wired
 * into the client's request pipeline), but a mutation already accepted by the
 * API server is not undone; callers treat "aborted during a write" as
 * `uncertain`, as the operations ledger does.
 */
import {
  ApiException,
  AppsV1Api,
  CoreV1Api,
  HttpMethod,
  KubernetesObjectApi,
  PatchStrategy,
  ServerConfiguration,
  createConfiguration,
  type Configuration,
  type KubeConfig,
  type KubernetesObject,
  type ResponseContext,
} from "@kubernetes/client-node";
import type { KubernetesSession } from "@/lib/credentials/types";
import { sessionNamespaces } from "./session";
import { ANNOTATION, K8sError, LABEL, MANAGED_BY_VALUE, KIND_INFO, type FieldConflict, type ObjectRef, type SupportedKind } from "./types";
import { isDnsLabel } from "./naming";
import { redactText, scrubValues, truncate, isRecord, dig } from "./util";

/* ------------------------------ error mapping ------------------------------ */

interface StatusBody {
  message?: string;
  reason?: string;
  details?: { name?: string; kind?: string; causes?: { reason?: string; message?: string; field?: string }[] };
}

function statusBody(e: ApiException<unknown>): StatusBody {
  const body = e.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as unknown;
      return isRecord(parsed) ? (parsed as StatusBody) : { message: body };
    } catch {
      return { message: body };
    }
  }
  return isRecord(body) ? (body as StatusBody) : {};
}

/** Field-manager conflicts carried by a 409: which fields, and who owns them. */
export function conflictsFrom(e: unknown): FieldConflict[] {
  if (!(e instanceof ApiException)) return [];
  const causes = statusBody(e).details?.causes ?? [];
  const out: FieldConflict[] = [];
  for (const c of causes) {
    if (c.reason !== "FieldManagerConflict" || typeof c.field !== "string") continue;
    const m = /conflict with "([^"]+)"/.exec(c.message ?? "");
    out.push({ field: c.field, manager: m?.[1] });
  }
  return out;
}

/** Whether an error means the API has no such kind (CRD not installed), as opposed to no such object. */
export function isKindUnavailable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : "";
  if (msg.startsWith("Unrecognized API version and kind")) return true;
  return e instanceof ApiException && e.code === 404 && msg.startsWith("Failed to fetch resource metadata");
}

/**
 * Normalize anything thrown by the client into a K8sError. `secrets` are the
 * secret values in memory for this call; they are scrubbed from any text the
 * server echoed back.
 */
export function toK8sError(e: unknown, secrets: readonly string[] = []): K8sError {
  if (e instanceof K8sError) return e;
  const clean = (s: string) => truncate(scrubValues(redactText(s), secrets), 500);
  if (isKindUnavailable(e)) return new K8sError("unsupported", "The cluster does not serve this API kind (is its CRD installed?).", 404);
  if (e instanceof ApiException) {
    const b = statusBody(e);
    const msg = clean(b.message ?? `HTTP ${e.code}`);
    switch (e.code) {
      case 401:
        return new K8sError("unauthorized", "The Kubernetes API rejected the credential (401).", 401);
      case 403:
        return new K8sError("forbidden", `Forbidden: ${msg}`, 403);
      case 404:
        return new K8sError("not_found", msg, 404);
      case 409:
        return new K8sError("field_conflict", msg, 409);
      case 422:
      case 400:
        return new K8sError("invalid", msg, e.code);
      default:
        return new K8sError("api_error", `Kubernetes API error ${e.code}: ${msg}`, e.code);
    }
  }
  const name = e instanceof Error ? e.name : "";
  if (name === "AbortError") return new K8sError("aborted", "The operation was aborted.");
  if (name === "TimeoutError") return new K8sError("timeout", "The Kubernetes API did not answer in time.");
  const cause = e instanceof Error ? (e as { cause?: { code?: string; name?: string } }).cause : undefined;
  if (cause?.name === "AbortError") return new K8sError("aborted", "The operation was aborted.");
  if (cause?.name === "TimeoutError") return new K8sError("timeout", "The Kubernetes API did not answer in time.");
  if (e instanceof TypeError || cause?.code) {
    return new K8sError("unreachable", `Cannot reach the Kubernetes API server${cause?.code ? ` (${String(cause.code).slice(0, 40)})` : ""}.`);
  }
  return new K8sError("api_error", clean(e instanceof Error ? e.message : "Unexpected error talking to the Kubernetes API."));
}

/* ------------------------------ raw object API ------------------------------ */

/**
 * The generic object client with the typed (de)serializer taken out.
 *
 * WHY: the library converts request and response bodies through generated
 * models. The model for a NetworkPolicy ingress rule names its `from` field
 * `_from` and silently DROPS a plain `from` on the way out, which turns
 * "allow only these peers" into "allow from anywhere" (an ingress rule with no
 * `from` matches every source). Zenith applies the exact JSON it rendered and
 * reads back the exact JSON the server returned; the contract tests assert the
 * bytes on the wire equal the rendered objects for every kind.
 */
export class RawObjectApi extends KubernetesObjectApi {
  /** Release Jobs retain the exact pod template JSON, including admission extensions. */
  override async create<T extends KubernetesObject>(spec: T, pretty?: string, dryRun?: string, fieldManager?: string, options?: Configuration): Promise<T> {
    const path = await this.specUriPath(spec, "create");
    const request = (options ?? this.configuration).baseServer.makeRequestContext(path, HttpMethod.POST);
    request.setHeaderParam("Accept", "application/json, */*;q=0.8");
    request.setHeaderParam("Content-Type", "application/json");
    if (pretty !== undefined) request.setQueryParam("pretty", pretty);
    if (dryRun !== undefined) request.setQueryParam("dryRun", dryRun);
    if (fieldManager !== undefined) request.setQueryParam("fieldManager", fieldManager);
    request.setBody(JSON.stringify(spec));
    return this.requestPromise<T>(request);
  }

  /** Same request as the base class, with the body sent as rendered (no model conversion). */
  override async patch<T extends KubernetesObject>(
    spec: T,
    pretty?: string,
    dryRun?: string,
    fieldManager?: string,
    force?: boolean,
    patchStrategy: PatchStrategy = PatchStrategy.StrategicMergePatch
  ): Promise<T> {
    const path = await this.specUriPath(spec, "patch");
    const request = this.configuration.baseServer.makeRequestContext(path, HttpMethod.PATCH);
    request.setHeaderParam("Accept", "application/json, */*;q=0.8");
    request.setHeaderParam("Content-Type", patchStrategy);
    if (pretty !== undefined) request.setQueryParam("pretty", pretty);
    if (dryRun !== undefined) request.setQueryParam("dryRun", dryRun);
    if (fieldManager !== undefined) request.setQueryParam("fieldManager", fieldManager);
    if (force !== undefined) request.setQueryParam("force", String(force));
    request.setBody(JSON.stringify(spec));
    return this.requestPromise<T>(request);
  }

  /**
   * Whether the API server positively reports that it does not serve a kind: discovery of its group/version
   * answers 404, or answers with a resource list that lacks the kind. Anything else (a timeout, a 5xx, a 401,
   * a 403, an unreadable list) throws: an unanswered question is not an answer, and a caller deciding that
   * "nothing of this kind can exist" must not treat it as one.
   */
  async kindAbsent(apiVersion: string, kind: string): Promise<boolean> {
    const path = apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
    const request = this.configuration.baseServer.makeRequestContext(path, HttpMethod.GET);
    request.setHeaderParam("Accept", "application/json");
    try {
      const list = await this.requestPromise<KubernetesObject>(request) as unknown as { resources?: unknown };
      if (!Array.isArray(list.resources)) throw new K8sError("api_error", "Discovery returned no resource list.");
      return !list.resources.some((r) => isRecord(r) && r.kind === kind);
    } catch (e) {
      if (e instanceof ApiException && e.code === 404) return true;
      throw e;
    }
  }

  /** Successful responses are returned as the server's JSON; failures keep the library's ApiException. */
  protected override async processResponse<T extends KubernetesObject>(response: ResponseContext, _type?: string): Promise<T> {
    if (response.httpStatusCode >= 200 && response.httpStatusCode <= 299) {
      return JSON.parse(await response.body.text()) as T;
    }
    throw new ApiException(response.httpStatusCode, "Unsuccessful HTTP Request", await response.getBodyAsAny(), response.headers);
  }
}

/* ------------------------------ namespace guard ----------------------------- */

/**
 * Enforces `KubernetesConnectionConfig.namespaces` on every namespaced call.
 * A namespace outside the allowlist passes only when it is one Zenith created
 * (labeled managed-by=zenith and, when the client is bound to an environment,
 * annotated with that environment). Everything else fails closed, including a
 * namespace whose lookup is forbidden or errors.
 */
export class NamespaceGuard {
  private readonly zenithOwned = new Set<string>();
  constructor(
    private readonly allow: ReadonlySet<string>,
    private readonly environmentId: string | undefined,
    private readonly lookup: (name: string) => Promise<Record<string, unknown> | undefined>
  ) {}

  /** A namespace this very batch is about to create (labeled) counts as Zenith-created. */
  registerZenithCreated(ns: string): void {
    this.zenithOwned.add(ns);
  }

  isAllowlisted(ns: string): boolean {
    return this.allow.has(ns);
  }

  async assert(ns: string): Promise<void> {
    if (!isDnsLabel(ns)) throw new K8sError("bad_input", "Namespace is not a valid DNS label.");
    if (this.allow.has(ns) || this.zenithOwned.has(ns)) return;
    let live: Record<string, unknown> | undefined;
    let lookupOk = true;
    try {
      live = await this.lookup(ns);
    } catch {
      live = undefined;
      lookupOk = false;
    }
    if (live === undefined && lookupOk) {
      throw new K8sError("not_found", `Namespace "${ns}" does not exist and is outside this connection's allowlist.`);
    }
    const labels = dig(live, "metadata", "labels");
    const annotations = dig(live, "metadata", "annotations");
    const ours =
      isRecord(labels) &&
      labels[LABEL.managedBy] === MANAGED_BY_VALUE &&
      (this.environmentId === undefined || (isRecord(annotations) && annotations[ANNOTATION.environment] === this.environmentId));
    if (!ours) {
      throw new K8sError(
        "namespace_forbidden",
        `Namespace "${ns}" is outside this connection's allowlist and was not created by Zenith for this environment.`
      );
    }
    this.zenithOwned.add(ns);
  }
}

/* --------------------------------- client ---------------------------------- */

export interface ClientOptions {
  signal?: AbortSignal;
  /** bind ownership-sensitive checks (namespace guard) to this environment */
  environmentId?: string;
  /** per-request ceiling, default 30 s */
  requestTimeoutMs?: number;
}

export interface K8sClient {
  readonly server: string;
  readonly environmentId?: string;
  readonly signal?: AbortSignal;
  /** raw JSON in, raw JSON out: use for every read and every apply */
  readonly objects: RawObjectApi;
  /** typed clients, used only where a typed result is the point (pod logs, the scale subresource) */
  readonly core: CoreV1Api;
  readonly apps: AppsV1Api;
  readonly guard: NamespaceGuard;
}

function kubeConfigOf(session: KubernetesSession): KubeConfig {
  const kc = session.kubeConfig() as Partial<KubeConfig> | null;
  if (!kc || typeof kc.getCurrentCluster !== "function" || typeof kc.applySecurityAuthentication !== "function") {
    throw new K8sError("session_invalid", "Session did not provide a usable KubeConfig.");
  }
  return kc as KubeConfig;
}

export function createK8sClient(session: KubernetesSession, opts: ClientOptions = {}): K8sClient {
  if (opts.signal?.aborted) throw new K8sError("aborted", "The operation was aborted.");
  const kc = kubeConfigOf(session);
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new K8sError("session_invalid", "KubeConfig has no current cluster.");
  const timeoutMs = opts.requestTimeoutMs ?? 30_000;
  const configuration = createConfiguration({
    baseServer: new ServerConfiguration(cluster.server, {}),
    authMethods: { default: kc },
    promiseMiddleware: [
      {
        pre: async (ctx) => {
          ctx.setHeaderParam("User-Agent", "zenith-k8s-driver");
          const timeout = AbortSignal.timeout(timeoutMs);
          ctx.setSignal(opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout);
          return ctx;
        },
        post: async (r) => r,
      },
    ],
  });
  const objects = new RawObjectApi(configuration);
  const guard = new NamespaceGuard(new Set(sessionNamespaces(session)), opts.environmentId, async (name) => {
    try {
      return (await objects.read({ apiVersion: "v1", kind: "Namespace", metadata: { name } })) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof ApiException && e.code === 404 && !isKindUnavailable(e)) return undefined;
      throw e;
    }
  });
  return {
    server: cluster.server,
    environmentId: opts.environmentId,
    signal: opts.signal,
    objects,
    core: new CoreV1Api(configuration),
    apps: new AppsV1Api(configuration),
    guard,
  };
}

/* ------------------------------ object helpers ----------------------------- */

export const isNamespacedKind = (kind: string): boolean => (KIND_INFO as Record<string, { namespaced: boolean }>)[kind]?.namespaced ?? true;

/** Read one object; `undefined` when it does not exist. Throws `unsupported` when the kind is not served. */
export async function readObject(client: K8sClient, ref: ObjectRef): Promise<Record<string, unknown> | undefined> {
  try {
    const got = await client.objects.read({
      apiVersion: ref.apiVersion,
      kind: ref.kind,
      metadata: { name: ref.name, ...(ref.namespace ? { namespace: ref.namespace } : {}) },
    });
    return got as unknown as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ApiException && e.code === 404 && !isKindUnavailable(e)) return undefined;
    throw toK8sError(e);
  }
}

export interface ListResult {
  items: Record<string, unknown>[];
  /** more objects exist than were returned */
  truncated: boolean;
  /** the cluster does not serve this kind (for example its CRD is not installed) */
  unavailable: boolean;
}

/**
 * List any kind with a bounded page size and page count. A kind the cluster
 * does not serve lists as empty with `unavailable: true`.
 */
export async function listByKind(
  client: K8sClient,
  target: { apiVersion: string; kind: string; namespaced: boolean },
  namespace: string | undefined,
  opts: { labelSelector?: string; limit?: number; maxPages?: number } = {}
): Promise<ListResult> {
  const limit = opts.limit ?? 200;
  const maxPages = opts.maxPages ?? 5;
  const items: Record<string, unknown>[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    let res: { items?: unknown[]; metadata?: { continue?: string; _continue?: string } };
    try {
      res = (await client.objects.list<never>(
        target.apiVersion,
        target.kind,
        target.namespaced ? namespace : undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        opts.labelSelector,
        limit,
        token
      )) as unknown as typeof res;
    } catch (e) {
      if (isKindUnavailable(e)) return { items, truncated: false, unavailable: true };
      throw toK8sError(e);
    }
    for (const it of res.items ?? []) if (isRecord(it)) items.push({ apiVersion: target.apiVersion, kind: target.kind, ...it });
    token = res.metadata?.continue ?? res.metadata?._continue;
    if (!token) return { items, truncated: false, unavailable: false };
  }
  return { items, truncated: true, unavailable: false };
}

/** List one of the kinds Zenith renders. */
export function listObjects(
  client: K8sClient,
  kind: SupportedKind,
  namespace: string | undefined,
  opts: { labelSelector?: string; limit?: number; maxPages?: number } = {}
): Promise<ListResult> {
  const info = KIND_INFO[kind];
  return listByKind(client, { apiVersion: info.apiVersion, kind, namespaced: info.namespaced }, namespace, opts);
}

/** Kinds Zenith only READS (never applies): what workloads create or the cluster emits. */
export const READ_ONLY_KINDS = {
  Pod: { apiVersion: "v1", kind: "Pod", namespaced: true },
  Event: { apiVersion: "v1", kind: "Event", namespaced: true },
  ReplicaSet: { apiVersion: "apps/v1", kind: "ReplicaSet", namespaced: true },
  ControllerRevision: { apiVersion: "apps/v1", kind: "ControllerRevision", namespaced: true },
  DaemonSet: { apiVersion: "apps/v1", kind: "DaemonSet", namespaced: true },
  Job: { apiVersion: "batch/v1", kind: "Job", namespaced: true },
  PersistentVolume: { apiVersion: "v1", kind: "PersistentVolume", namespaced: false },
} as const;

/**
 * Kinds that belong to the optional CSI snapshot add-on (external-snapshotter
 * CRDs). Zenith creates VolumeSnapshots only through the snapshot operation and
 * reads VolumeSnapshotClasses to decide whether a cluster can snapshot at all;
 * neither is part of the declarative apply set (`KIND_INFO`). A cluster without
 * the CRDs lists them as `unavailable`.
 */
export const SNAPSHOT_KINDS = {
  VolumeSnapshot: { apiVersion: "snapshot.storage.k8s.io/v1", kind: "VolumeSnapshot", namespaced: true },
  VolumeSnapshotClass: { apiVersion: "snapshot.storage.k8s.io/v1", kind: "VolumeSnapshotClass", namespaced: false },
} as const;

/** Whether a live object carries Zenith's ownership marks for this environment. */
export function ownedBy(live: Record<string, unknown>, environmentId: string): { owned: boolean; reason?: string } {
  const labels = dig(live, "metadata", "labels");
  const annotations = dig(live, "metadata", "annotations");
  if (!isRecord(labels) || labels[LABEL.managedBy] !== MANAGED_BY_VALUE) {
    return { owned: false, reason: `missing ${LABEL.managedBy}=${MANAGED_BY_VALUE}` };
  }
  if (!isRecord(annotations) || annotations[ANNOTATION.environment] !== environmentId) {
    return { owned: false, reason: `${ANNOTATION.environment} does not match this environment` };
  }
  return { owned: true };
}
