/**
 * Kubernetes transport (ADR-0012, ADR-0015): pod/container operations through
 * the Kubernetes API (list, read, log) and pod exec, using the
 * `KubernetesSession` the credential broker produced.
 *
 * Target ids are `namespace`, `namespace/pod` or `namespace/pod/container`.
 * Every request is refused unless its namespace is in the session's
 * allowlist (`KubernetesConnectionConfig.namespaces`, carried on
 * `KubernetesMachineSession.namespaces`); an empty allowlist refuses
 * everything, because "namespaces Zenith created" cannot be proven from here.
 *
 * What maps where:
 *   container.list     list pods (optionally by label selector), flatten containers
 *   container.inspect  read the pod; a fixed set of status fields (never env/spec args)
 *   container.logs     read pod log, tail lines + sinceSeconds, bounded; newest bytes kept
 *   container.exec     exec argv, bounded output/time            (escape hatch)
 *   process.list       exec `ps -eo pid,comm,pcpu,pmem` (argv)   (reports `unavailable` on images without ps)
 *   file.read          exec `readlink -f` then `head -c` (argv), with prefix allowlist,
 *                      secret-name denylist and a symlink-escape re-check
 *   network.portCheck / network.dnsCheck: unsupported (no probe tool can be assumed in an image)
 *
 * Verified against injected fakes and a local fake API server only; never
 * against a real cluster (none reachable from here). The exec path in
 * particular depends on `@kubernetes/client-node` v2 `Exec` semantics.
 */
import type { V1Pod, V1PodList } from "@kubernetes/client-node";
import { capability } from "@/lib/capabilities/catalog";
import { sha256Hex } from "@/lib/controlplane/digest";
import { isImplementedOperation, parseMachineArgs } from "../args";
import { MachineOperationError } from "../errors";
import { isDeniedFilePath, normalizeAbsolutePath, parseSince, pathAllowed } from "../guards";
import { DEFAULT_FILE_READ_PREFIXES } from "../limits";
import { keepTailUtf8 } from "../redact";
import { MachineFailureDataSchema, type MachineFailureCode } from "../results";
import type { KubernetesMachineSession, MachineDriver, MachineOperation, MachineRequest, MachineResult } from "../types";
import { runExec, type ExecClient, type ExecOutcome } from "./kubernetes-exec";
import { containerSummaries, inspectPod, parseK8sTarget, parsePsOutput, resolveContainer, type K8sTarget } from "./kubernetes-pods";

/* --------------------------------- clients --------------------------------- */

/** the subset of `CoreV1Api` used here (structurally satisfied by the real v2 client) */
export interface K8sCoreClient {
  listNamespacedPod(p: { namespace: string; labelSelector?: string; fieldSelector?: string; limit?: number }): Promise<V1PodList>;
  readNamespacedPod(p: { name: string; namespace: string }): Promise<V1Pod>;
  readNamespacedPodLog(p: { name: string; namespace: string; container?: string; tailLines?: number; sinceSeconds?: number; limitBytes?: number; timestamps?: boolean }): Promise<string>;
}
export interface K8sClients {
  core: K8sCoreClient;
  exec: ExecClient;
}
/** builds API clients from the session's `KubeConfig` (an `unknown` in the credential contract) */
export type K8sClientFactory = (kubeConfig: unknown) => Promise<K8sClients>;

/** Real clients: `CoreV1Api` and `Exec` from `@kubernetes/client-node`, loaded lazily. */
export const defaultK8sClientFactory: K8sClientFactory = async (kubeConfig) => {
  const k8s = await import("@kubernetes/client-node");
  if (typeof kubeConfig !== "object" || kubeConfig === null || !(kubeConfig instanceof k8s.KubeConfig)) {
    throw new MachineOperationError("transport_error", "the Kubernetes session did not provide a KubeConfig");
  }
  return { core: kubeConfig.makeApiClient(k8s.CoreV1Api), exec: new k8s.Exec(kubeConfig) };
};

export interface KubernetesDriverOptions {
  clientFactory?: K8sClientFactory;
  /** default {@link DEFAULT_FILE_READ_PREFIXES} */
  fileReadPrefixes?: readonly string[];
  /** ceiling on pods listed per container.list (default 200) */
  maxListPods?: number;
  now?: () => number;
}

const SUPPORTED: readonly MachineOperation[] = ["container.list", "container.inspect", "container.logs", "container.exec", "process.list", "file.read"];

const UNSUPPORTED: Partial<Record<MachineOperation, string>> = {
  "network.portCheck": "no probe tool can be assumed inside an arbitrary container image; use the zenith-runner probes (probe.tcp) or a zenithd-managed node",
  "network.dnsCheck": "no resolver tool can be assumed inside an arbitrary container image; use the zenith-runner probes (probe.dns) or a zenithd-managed node",
  "machine.inspect": "machine operations target VMs; use container.inspect for pods",
  "service.status": "systemd units do not exist on Kubernetes targets",
  "machine.service.restart": "use service.restart (workload restart) for Kubernetes workloads",
  "system.metrics": "use metrics.read for Kubernetes workloads",
  "system.logs": "use container.logs for Kubernetes workloads",
  "machine.exec": "use container.exec for Kubernetes workloads",
  "file.write": "file.write requires an opt-in Linux zenithd local-template profile and is not supported by this transport",
  "file.upload": "file.upload requires an opt-in Linux zenithd local binary profile and is not supported by this transport",
  "package.install": "package.install requires the opt-in Debian data-only zenithd root helper and is unsupported by this transport",
};

/* --------------------------------- helpers --------------------------------- */

function isK8sSession(s: unknown): s is KubernetesMachineSession {
  const x = s as Partial<KubernetesMachineSession> | null;
  return typeof x === "object" && x !== null && x.provider === "kubernetes" && typeof x.kubeConfig === "function" && Array.isArray(x.namespaces);
}

function httpStatusOf(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const o = e as { code?: unknown; statusCode?: unknown; message?: unknown };
  if (typeof o.code === "number") return o.code;
  if (typeof o.statusCode === "number") return o.statusCode;
  const m = typeof o.message === "string" ? /Unexpected server response: (\d{3})/.exec(o.message) : null;
  return m ? Number(m[1]) : undefined;
}

const isAbort = (e: unknown): boolean => typeof e === "object" && e !== null && "name" in e && ((e as { name: unknown }).name === "AbortError" || (e as { name: unknown }).name === "TimeoutError");

/** Bound a promise by the request's time budget and its abort signal (the client has no per-call signal). */
function bounded<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("The Kubernetes API call exceeded the request time budget", "TimeoutError"));
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

function mapK8sError(e: unknown): MachineOperationError {
  if (e instanceof MachineOperationError) return e;
  const status = httpStatusOf(e);
  if (status === 403) return new MachineOperationError("denied", "the Kubernetes API refused the request (RBAC); check the session's permissions", { cause: e });
  if (status === 401) return new MachineOperationError("transport_error", "the Kubernetes API rejected the session credentials", { cause: e });
  if (status === 429 || (status !== undefined && status >= 500)) return new MachineOperationError("transport_error", `the Kubernetes API failed (${status})`, { retryable: true, cause: e });
  const msg = typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message).slice(0, 160) : "unknown error";
  return new MachineOperationError("transport_error", `Kubernetes call failed: ${msg}`, { cause: e });
}

const failure = (code: MachineFailureCode, reason?: string, extra: { exitCode?: number | null; timedOut?: boolean } = {}): Record<string, unknown> =>
  MachineFailureDataSchema.parse({ error: code, ...(reason ? { reason: reason.slice(0, 1000) } : {}), ...extra });

const MISSING_TOOL = /executable file not found|not found in \$PATH|no such file or directory|exec format error|command not found/i;

/* --------------------------------- driver ---------------------------------- */

export function createKubernetesMachineDriver(options: KubernetesDriverOptions = {}): MachineDriver {
  const factory = options.clientFactory ?? defaultK8sClientFactory;
  const prefixes = options.fileReadPrefixes ?? DEFAULT_FILE_READ_PREFIXES;
  const maxPods = options.maxListPods ?? 200;
  const now = options.now ?? Date.now;

  async function execute(req: MachineRequest, session: unknown, signal: AbortSignal): Promise<MachineResult> {
    if (!isK8sSession(session)) throw new MachineOperationError("transport_error", "kubernetes requires a KubernetesSession with a namespace allowlist");
    if (!SUPPORTED.includes(req.operation) || !isImplementedOperation(req.operation)) {
      throw new MachineOperationError("unsupported_operation", UNSUPPORTED[req.operation] ?? `${req.operation} is not implemented for kubernetes`);
    }
    const target = parseK8sTarget(req.target.targetId);
    if (!session.namespaces.includes(target.namespace)) {
      throw new MachineOperationError("denied", "the namespace is not in this connection's allowlist");
    }
    const parsed = parseMachineArgs(req.operation, req.args);
    if (!parsed.ok) throw new MachineOperationError("invalid_args", "arguments failed validation", { issues: parsed.issues });
    const args = parsed.args as Record<string, unknown>;
    const startedAt = new Date(now()).toISOString();
    const mutating = capability(req.operation).mutates;
    const budgetMs = req.timeoutSec * 1000;

    const done = (ok: boolean, data: Record<string, unknown>, output?: MachineResult["output"]): MachineResult => ({
      ok,
      operation: req.operation,
      data,
      ...(output ? { output } : {}),
      startedAt,
      finishedAt: new Date(now()).toISOString(),
      transport: "kubernetes",
      simulated: false,
    });

    try {
      const clients = await bounded(factory(session.kubeConfig()), budgetMs, signal);
      const api = <T>(p: Promise<T>) => bounded(p, budgetMs, signal);

      if (req.operation === "container.list") {
        const { namespace, pod } = target;
        const list = await api(
          clients.core.listNamespacedPod({
            namespace,
            limit: maxPods,
            ...(typeof args.labelSelector === "string" ? { labelSelector: args.labelSelector } : {}),
            ...(pod ? { fieldSelector: `metadata.name=${pod}` } : {}),
          })
        );
        const all = list.items.flatMap((p) => containerSummaries(p, namespace, args.all === true));
        const limit = Number(args.limit);
        return done(true, { containers: all.slice(0, limit), truncated: all.length > limit || Boolean(list.metadata?._continue) });
      }

      const pod = needPod(target);
      const podObj = await loadPod(clients.core, target.namespace, pod, api);
      if (!podObj) return done(false, failure("not_found", "the pod does not exist in this namespace"));
      const requested = pickContainer(target, args);
      const container = resolveContainer(podObj, requested);

      switch (req.operation) {
        case "container.inspect":
          return done(true, inspectPod(podObj, target.namespace, container));

        case "container.logs": {
          const max = req.maxOutputBytes;
          const since = typeof args.since === "string" ? parseSince(args.since) : null;
          const raw = await api(
            clients.core.readNamespacedPodLog({
              name: pod,
              namespace: target.namespace,
              container,
              tailLines: Number(args.lines),
              ...(since ? { sinceSeconds: since } : {}),
              // the API keeps the OLDEST bytes of the tailed range; ask for twice the budget, keep the newest `max`
              limitBytes: max * 2,
              timestamps: args.timestamps === true,
            })
          );
          const text = typeof raw === "string" ? raw : String(raw);
          const kept = keepTailUtf8(text, max);
          const lineCount = kept.text.split("\n").filter((l) => l !== "").length;
          return done(true, { container, lines: lineCount, content: kept.text, truncated: kept.truncated || Buffer.byteLength(text) >= max * 2 });
        }

        case "container.exec": {
          const argv = args.argv as string[];
          const secs = Math.min(Number(args.timeoutSec), req.timeoutSec);
          const o = await runExec(clients.exec, target.namespace, pod, container, argv, { maxBytes: req.maxOutputBytes, timeoutMs: secs * 1000, signal });
          return execResult(done, o, mutating);
        }

        case "process.list": {
          const o = await runExec(clients.exec, target.namespace, pod, container, ["ps", "-eo", "pid,comm,pcpu,pmem"], { maxBytes: req.maxOutputBytes, timeoutMs: budgetMs, signal });
          const bad = execProblem(o);
          if (bad) return done(false, bad);
          if (o.exitCode !== 0) {
            const err = o.stderr.toString("utf8");
            const missing = o.exitCode === 126 || o.exitCode === 127 || MISSING_TOOL.test(err);
            return done(false, failure(missing ? "unavailable" : "command_failed", missing ? "ps is not available in this container image (distroless or minimal image)" : err.split("\n")[0], { exitCode: o.exitCode }));
          }
          return done(true, parsePsOutput(o.stdout.toString("utf8"), args.sortBy as "cpu" | "memory", Number(args.limit)));
        }

        case "file.read": {
          const path = String(args.path);
          assertReadable(path);
          const r = await runExec(clients.exec, target.namespace, pod, container, ["readlink", "-f", "--", path], { maxBytes: 4096, timeoutMs: budgetMs, signal });
          const badR = execProblem(r);
          if (badR) return done(false, badR);
          const resolved = r.stdout.toString("utf8").trim();
          if (r.exitCode !== 0 || !resolved) {
            const missing = r.exitCode === 126 || r.exitCode === 127 || MISSING_TOOL.test(r.stderr.toString("utf8"));
            // never read without resolving symlinks: fail closed when readlink cannot run
            return done(false, failure(missing ? "unavailable" : "not_found", missing ? "readlink is not available in this image, so the path cannot be checked for symlink escapes; refusing to read" : "the file does not exist", { exitCode: r.exitCode }));
          }
          const norm = normalizeAbsolutePath(resolved);
          if (!norm.ok) throw new MachineOperationError("denied", "the resolved path is not a plain absolute path");
          assertReadable(norm.path);
          const want = Math.min(Number(args.maxBytes), req.maxOutputBytes);
          const h = await runExec(clients.exec, target.namespace, pod, container, ["head", "-c", String(want + 1), "--", norm.path], { maxBytes: want + 1, timeoutMs: budgetMs, signal });
          const badH = execProblem(h);
          if (badH) return done(false, badH);
          if (h.exitCode !== 0) {
            return done(false, failure(MISSING_TOOL.test(h.stderr.toString("utf8")) ? "unavailable" : "command_failed", h.stderr.toString("utf8").split("\n")[0], { exitCode: h.exitCode }));
          }
          const bytes = h.stdout.length > want ? h.stdout.subarray(0, want) : h.stdout;
          const truncated = h.stdout.length > want || h.stdoutTruncated;
          const binary = bytes.includes(0);
          return done(true, {
            path: norm.path,
            ...(truncated ? {} : { sizeBytes: bytes.length }),
            bytesRead: bytes.length,
            truncated,
            encoding: "utf8",
            content: binary ? "" : bytes.toString("utf8"),
            ...(binary ? { binary: true } : {}),
            sha256: sha256Hex(bytes),
          });
        }

        default:
          throw new MachineOperationError("unsupported_operation", `${req.operation} is not implemented for kubernetes`);
      }
    } catch (e) {
      if (isAbort(e) || signal.aborted) {
        throw new MachineOperationError(mutating ? "uncertain" : "aborted", mutating ? "the exec request was interrupted; its outcome is unknown" : "the machine request was aborted or exceeded its time budget", { cause: e });
      }
      throw mapK8sError(e);
    }
  }

  function assertReadable(path: string): void {
    if (!pathAllowed(path, prefixes)) throw new MachineOperationError("denied", "path is not under an allowed file.read prefix for this environment");
    if (isDeniedFilePath(path)) throw new MachineOperationError("denied", "path matches a never-readable pattern");
  }

  /** Not-exit outcomes of an exec: read-only callers get an `ok: false` failure, mutating ones (see execResult) an `uncertain` error. */
  function execProblem(o: ExecOutcome): Record<string, unknown> | undefined {
    if (o.timedOut) return failure("timeout", "the command exceeded its time budget and the session was closed", { timedOut: true });
    if (o.overflow) return failure("output_limit", "the command produced far more output than the limit");
    if (o.exitCode === null) {
      const missing = o.failure && MISSING_TOOL.test(o.failure);
      return failure(missing ? "unavailable" : "command_failed", o.failure ?? "no exit status was received", { exitCode: null });
    }
    return undefined;
  }

  function execResult(done: (ok: boolean, data: Record<string, unknown>, output?: MachineResult["output"]) => MachineResult, o: ExecOutcome, mutating: boolean): MachineResult {
    const output = {
      stdout: o.stdout.toString("utf8"),
      stderr: o.stderr.toString("utf8"),
      exitCode: o.exitCode,
      truncated: o.stdoutTruncated || o.stderrTruncated,
    };
    if (o.exitCode === null) {
      const missing = o.failure && MISSING_TOOL.test(o.failure);
      // the command was never started: a definite failure, not an unknown
      if (missing) return done(false, failure("unavailable", o.failure, { exitCode: null }), output);
      if (mutating) {
        const why = o.timedOut ? "timed out" : o.overflow ? "produced runaway output" : (o.failure ?? "lost its connection");
        throw new MachineOperationError("uncertain", `the exec ${why}; the command may still be running or may have completed`);
      }
    }
    return done(o.exitCode === 0, { exitCode: o.exitCode }, output);
  }

  return { transport: "kubernetes", supports: SUPPORTED, unsupported: UNSUPPORTED, execute };
}

/* --------------------------------- lookups --------------------------------- */

function needPod(t: K8sTarget): string {
  if (!t.pod) throw new MachineOperationError("invalid_request", "kubernetes targetId must name a pod (namespace/pod) for this operation");
  return t.pod;
}

function pickContainer(t: K8sTarget, args: Record<string, unknown>): string | undefined {
  const a = typeof args.container === "string" ? args.container : undefined;
  if (t.container && a && t.container !== a) throw new MachineOperationError("invalid_args", "args.container conflicts with the container named in the target");
  return t.container ?? a;
}

async function loadPod(core: K8sCoreClient, namespace: string, name: string, api: <T>(p: Promise<T>) => Promise<T>): Promise<V1Pod | undefined> {
  try {
    return await api(core.readNamespacedPod({ name, namespace }));
  } catch (e) {
    if (httpStatusOf(e) === 404) return undefined;
    throw e;
  }
}
