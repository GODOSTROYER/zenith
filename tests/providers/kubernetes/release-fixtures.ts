/** Synthetic API and Job controller fixtures; contract evidence only. */
import { expect } from "vitest";
import { serverSideApply } from "@/lib/providers/kubernetes/apply";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { createReleasePorts } from "@/lib/platform/release";
import { startFakeK8s } from "./fake-api";
import { ENV_ID, NS, driverCtx, inNs, serviceNode, sessionFor } from "./helpers";

export const DIGEST = `sha256:${"a".repeat(64)}`;
export const IMAGE = `ghcr.io/acme/web@${DIGEST}`;
export const NEXT_DIGEST = `sha256:${"b".repeat(64)}`;
export const NEXT_IMAGE = `ghcr.io/acme/web@${NEXT_DIGEST}`;
export const COMMAND = ["node", "migrate.js", "$(external-data)"];
export const OPTIONS = { idempotencyKey: "operation:migrate", timeoutMs: 1500 };

export async function releaseWorld(over: Record<string, unknown> = {}, kind: "Deployment" | "StatefulSet" = "Deployment") {
  const fake = await startFakeK8s();
  const session = await sessionFor(fake);
  const node = { ...inNs(serviceNode({ env: [], artifact: { type: "image", ref: IMAGE }, ...over })), nativeType: `k8s:${kind}` };
  const objects = renderGraph([node], { environmentId: ENV_ID }).objects;
  const workload = objects.find((o) => o.kind === "Deployment")!;
  if (kind === "StatefulSet") { workload.kind = kind; workload.spec = { ...workload.spec, serviceName: "web" }; }
  expect((await serverSideApply(objects, session, { environmentId: ENV_ID })).ok).toBe(true);
  const logs: string[] = [];
  const ctx = driverCtx(session, { log: (s) => logs.push(s), operationId: "op-migrate", fence: { scope: "env", token: 7 } });
  return { fake, session, node, ctx, logs, ports: createReleasePorts() };
}
export type World = Awaited<ReturnType<typeof releaseWorld>>;

export function finishJobs(w: World, opts: { exitCode?: number; missingExit?: boolean; foreignPod?: boolean; log?: string } = {}) {
  w.fake.inject({
    match: (r) => {
      if (r.method !== "GET" || !/\/jobs\/zenith-migrate-/.test(r.path)) return false;
      const name = r.path.split("/").at(-1)!;
      const job = w.fake.get("Job", NS, name);
      if (!job) return false;
      const exitCode = opts.exitCode ?? 0;
      w.fake.setStatus("Job", NS, name, { conditions: [{ type: exitCode === 0 ? "Complete" : "Failed", status: "True" }] });
      const uid = job.metadata.uid as string;
      const container = job.spec.template.spec.containers[0];
      w.fake.seedPod({ apiVersion: "v1", kind: "Pod", metadata: { name: `${name}-pod`, namespace: NS, labels: { "batch.kubernetes.io/controller-uid": uid }, ownerReferences: [{ kind: "Job", uid: opts.foreignPod ? "foreign-uid" : uid, controller: true }] }, status: { phase: exitCode === 0 ? "Succeeded" : "Failed", containerStatuses: [{ name: container.name, state: { terminated: opts.missingExit ? {} : { exitCode } } }] } });
      w.fake.setLog(NS, `${name}-pod`, opts.log ?? "migration completed");
      return false;
    }, status: 200, message: "",
  });
}
