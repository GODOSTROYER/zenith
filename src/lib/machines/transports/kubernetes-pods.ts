/**
 * Kubernetes pod → machine-result mappers and the small name/target parsers
 * the Kubernetes transport shares. Pure functions over the `@kubernetes/client-node`
 * object model (dates may arrive as `Date` or ISO strings); no I/O.
 *
 * Only a fixed set of status fields is ever read. Container `env`, `args`,
 * volumes, annotations and labels are never copied into a result: pod specs
 * are where inlined secrets live.
 */
import type { V1ContainerStatus, V1Pod } from "@kubernetes/client-node";
import { MachineOperationError } from "../errors";
import type { MachineData } from "../results";

/** DNS-1123 label (namespace, container) and subdomain (pod): the only shapes that are safe in an API path. */
export const K8S_LABEL_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
export const K8S_SUBDOMAIN_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

export interface K8sTarget {
  namespace: string;
  pod?: string;
  container?: string;
}

/** `namespace`, `namespace/pod` or `namespace/pod/container`; every segment validated. */
export function parseK8sTarget(targetId: string): K8sTarget {
  const parts = targetId.split("/");
  if (parts.length < 1 || parts.length > 3) throw new MachineOperationError("invalid_request", "kubernetes targetId must be namespace[/pod[/container]]");
  const [namespace, pod, container] = parts;
  if (!K8S_LABEL_RE.test(namespace)) throw new MachineOperationError("invalid_request", "kubernetes targetId has an invalid namespace");
  if (pod !== undefined && !K8S_SUBDOMAIN_RE.test(pod)) throw new MachineOperationError("invalid_request", "kubernetes targetId has an invalid pod name");
  if (container !== undefined && !K8S_LABEL_RE.test(container)) throw new MachineOperationError("invalid_request", "kubernetes targetId has an invalid container name");
  return { namespace, pod, container };
}

const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === "string" && v ? v : undefined);

export interface ContainerView {
  state: string;
  reason?: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  oomKilled: boolean;
  ready?: boolean;
  restartCount?: number;
}

export function viewContainer(cs: V1ContainerStatus | undefined): ContainerView {
  if (!cs) return { state: "unknown", oomKilled: false };
  const s = cs.state;
  const last = cs.lastState?.terminated;
  const base = { ready: cs.ready, restartCount: cs.restartCount, oomKilled: s?.terminated?.reason === "OOMKilled" || last?.reason === "OOMKilled" };
  if (s?.running) return { ...base, state: "running", startedAt: iso(s.running.startedAt) };
  if (s?.waiting) return { ...base, state: "waiting", reason: s.waiting.reason };
  if (s?.terminated) {
    return { ...base, state: "terminated", reason: s.terminated.reason, exitCode: s.terminated.exitCode, startedAt: iso(s.terminated.startedAt), finishedAt: iso(s.terminated.finishedAt) };
  }
  return { ...base, state: "unknown" };
}

const statusOf = (pod: V1Pod, name: string): V1ContainerStatus | undefined => pod.status?.containerStatuses?.find((c) => c.name === name);

/**
 * Pick the container a request is about. Explicit choice wins; otherwise a
 * single-container pod, then the `kubectl.kubernetes.io/default-container`
 * annotation; anything else is ambiguous and refused rather than guessed.
 */
export function resolveContainer(pod: V1Pod, requested: string | undefined): string {
  const names = (pod.spec?.containers ?? []).map((c) => c.name);
  if (requested !== undefined) {
    if (!names.includes(requested)) throw new MachineOperationError("invalid_args", `the pod has no container named ${JSON.stringify(requested.slice(0, 63))}`);
    return requested;
  }
  if (names.length === 1) return names[0];
  const dflt = pod.metadata?.annotations?.["kubectl.kubernetes.io/default-container"];
  if (dflt && names.includes(dflt)) return dflt;
  throw new MachineOperationError("invalid_args", `the pod has ${names.length} containers; name one in args.container or the target`);
}

export function containerSummaries(pod: V1Pod, ns: string, all: boolean): MachineData<"container.list">["containers"] {
  const podName = pod.metadata?.name ?? "";
  return (pod.spec?.containers ?? []).flatMap((c) => {
    const v = viewContainer(statusOf(pod, c.name));
    if (!all && v.state === "terminated") return [];
    return [
      {
        id: `${ns}/${podName}/${c.name}`,
        name: c.name,
        image: c.image,
        state: v.state,
        status: v.reason ?? pod.status?.phase,
        pod: podName,
        namespace: ns,
        ready: v.ready,
        restartCount: v.restartCount,
      },
    ];
  });
}

export function inspectPod(pod: V1Pod, ns: string, container: string): MachineData<"container.inspect"> {
  const podName = pod.metadata?.name ?? "";
  const spec = pod.spec?.containers?.find((c) => c.name === container);
  const v = viewContainer(statusOf(pod, container));
  return {
    id: `${ns}/${podName}/${container}`,
    name: container,
    image: spec?.image,
    state: v.state,
    running: v.state === "running",
    exitCode: v.exitCode,
    startedAt: v.startedAt,
    finishedAt: v.finishedAt,
    restartCount: v.restartCount,
    health: v.ready === undefined ? undefined : v.ready ? "ready" : "not_ready",
    oomKilled: v.oomKilled || undefined,
    namespace: ns,
    pod: podName,
    node: pod.spec?.nodeName,
    phase: pod.status?.phase,
    conditions: (pod.status?.conditions ?? []).slice(0, 16).map((c) => ({ type: c.type, status: c.status, reason: c.reason })),
    containerStatuses: (pod.spec?.containers ?? []).slice(0, 32).map((c) => {
      const cv = viewContainer(statusOf(pod, c.name));
      return { name: c.name, image: c.image, ready: cv.ready, restartCount: cv.restartCount, state: cv.state, reason: cv.reason, exitCode: cv.exitCode, startedAt: cv.startedAt };
    }),
  };
}

/** `ps -eo pid,comm,pcpu,pmem` → processes; the header row and malformed rows are skipped. */
export function parsePsOutput(text: string, sortBy: "cpu" | "memory", limit: number): MachineData<"process.list"> {
  const rows = text
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .flatMap((t) => {
      if (t.length < 4 || !/^\d+$/.test(t[0])) return [];
      const cpu = Number(t[t.length - 2]);
      const mem = Number(t[t.length - 1]);
      if (!Number.isFinite(cpu) || !Number.isFinite(mem)) return [];
      return [{ pid: Number(t[0]), command: t.slice(1, -2).join(" ").slice(0, 256), cpuPct: cpu, memPct: mem }];
    });
  rows.sort((a, b) => (sortBy === "cpu" ? b.cpuPct - a.cpuPct : b.memPct - a.memPct));
  return { processes: rows.slice(0, limit), truncated: rows.length > limit };
}
