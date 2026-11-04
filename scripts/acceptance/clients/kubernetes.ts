/** Bounded, shell-free kubectl verification. Only the selected context is used;
 * credentials stay in kubeconfig/credential helpers. Deletion rechecks the run
 * label and uses a UID precondition to avoid deleting a replaced namespace. */
import { spawn } from "node:child_process";
import { redactCredentials } from "@/lib/credentials/redact";
import { assertRunId } from "../safety";

const ALLOWED = ["PATH", "SystemRoot", "HOME", "USERPROFILE", "KUBECONFIG", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"];
export function kubectlEnv(host: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  return Object.fromEntries(ALLOWED.flatMap((k) => host[k] === undefined ? [] : [[k, host[k]]]));
}
export interface Kubectl {
  run(args: string[], timeoutMs?: number, input?: string): Promise<string>;
  forward(namespace: string, service: string): Promise<{ url: string; close(): Promise<void> }>;
}
export function createKubectl(context: string): Kubectl {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,120}$/.test(context)) throw new Error("Invalid Kubernetes context.");
  const start = (args: string[]) => spawn("kubectl", ["--context", context, ...args], { shell: false, windowsHide: true, env: kubectlEnv() as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
  return {
    run(args, timeoutMs = 30_000, input) {
      return new Promise((resolve, reject) => {
        const child = start(args);
        let out = "";
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
        child.stdout.on("data", (d: Buffer) => { out = (out + d.toString("utf8")).slice(0, 1_048_576); });
        // Error messages can contain auth plugin output; never return stderr.
        child.stderr.resume();
        child.stdin.on("error", () => undefined);
        child.stdin.end(input);
        child.once("error", () => { clearTimeout(timer); reject(new Error("Could not start kubectl.")); });
        child.once("close", (code) => { clearTimeout(timer); if (timedOut || code !== 0) reject(new Error(timedOut ? "kubectl timed out." : `kubectl exited ${code}.`)); else resolve(redactCredentials(out)); });
      });
    },
    forward(namespace, service) {
      assertRunId(namespace);
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(service)) throw new Error("Invalid Kubernetes service name.");
      return new Promise((resolve, reject) => {
        const child = start(["-n", namespace, "port-forward", `service/${service}`, ":8080", "--address", "127.0.0.1"]);
        child.stdin.end();
        let ready = false;
        let out = "";
        const timer = setTimeout(() => { child.kill(); reject(new Error("kubectl port-forward timed out.")); }, 30_000);
        child.stderr.resume();
        child.stdout.on("data", (d: Buffer) => {
          out = (out + d.toString("utf8")).slice(-2_000);
          const port = /Forwarding from 127\.0\.0\.1:(\d+) ->/.exec(out)?.[1];
          if (!ready && port) {
            ready = true; clearTimeout(timer);
            resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => { if (child.exitCode !== null) { done(); return; } child.once("close", () => done()); child.kill(); }) });
          }
        });
        child.once("error", () => { clearTimeout(timer); reject(new Error("Could not start kubectl port-forward.")); });
        child.once("close", () => { clearTimeout(timer); if (!ready) reject(new Error("kubectl port-forward stopped before becoming ready.")); });
      });
    },
  };
}

export const KUBE_RUN_LABEL = "zenith.io/live-run";
export async function verifyRunNamespace(kube: Kubectl, runId: string): Promise<{ uid: string; resourceVersion: string }> {
  assertRunId(runId);
  const ns = JSON.parse(await kube.run(["get", "namespace", runId, "-o", "json"])) as { metadata?: { uid?: string; resourceVersion?: string; labels?: Record<string, string> } };
  if (ns.metadata?.labels?.[KUBE_RUN_LABEL] !== runId || !ns.metadata.uid || !ns.metadata.resourceVersion) throw new Error("Namespace is not provably this run's; refusing.");
  return { uid: ns.metadata.uid, resourceVersion: ns.metadata.resourceVersion };
}

export async function deleteRunNamespace(kube: Kubectl, runId: string): Promise<void> {
  const raw = await kube.run(["get", "namespace", assertRunId(runId), "--ignore-not-found", "-o", "json"]);
  if (!raw.trim()) return;
  const preconditions = await verifyRunNamespace(kube, runId);
  // kubectl delete has no UID precondition flag; use the raw API request with
  // DeleteOptions on stdin. This also avoids a shell and does not persist kube creds.
  await kube.run(["delete", "--raw", `/api/v1/namespaces/${runId}`, "-f", "-"], 120_000, JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", preconditions }));
  await kube.run(["wait", "--for=delete", `namespace/${runId}`, "--timeout=120s"], 130_000);
}
