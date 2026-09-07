/**
 * Hosted runtimes: `local` (this process) and `cloudflare` (Workers for
 * Platforms, gated on credentials).
 *
 * Both implement one interface, so the gateway, the release runner and the
 * screens never branch on which one is running. What differs is what each can
 * honestly claim: the local runtime is real and serves apps today on one host;
 * the Cloudflare adapter builds real API requests and refuses, by name, until
 * the three inputs it needs exist.
 *
 * `ZENITH_CF_API_TOKEN` is read on exactly one line in this file, and nowhere
 * else in `src/`.
 *
 * Workstream W6 (hosted R3).
 */
import { hostedConfig } from "@/lib/hosted/config";
import { HostedError, type HostedRuntime, type RuntimeId } from "@/lib/hosted/contracts";
import { CloudflareRuntime } from "./cloudflare";
import { LocalRuntime } from "./local";
import type { SelectableRuntime } from "./selectable";

export { LocalRuntime, type LocalRuntimeOptions } from "./local";
export {
  CF_COMPATIBILITY_DATE,
  CloudflareRuntime,
  isAllowedBrokerBindings,
  isAllowedReleaseBindings,
  RELEASE_WORKER_MODULE,
  scriptUpload,
  type CloudflareRuntimeOptions,
} from "./cloudflare";
export {
  assertCfName,
  assertNamespace,
  CF_API_ORIGIN,
  CF_MAX_RESPONSE_BYTES,
  CF_REQUEST_TIMEOUT_MS,
  CloudflareApiClient,
  type CfFetch,
  type CfRequest,
} from "./cf-api";
export { brokerScriptName, releaseScriptName } from "./names";
export type { SelectableRuntime } from "./selectable";

/**
 * Every runtime this build knows, available or blocked-with-reason.
 *
 * Built fresh on each call rather than memoised: a runtime holds the
 * environment it was constructed from, and a process that has just had
 * `ZENITH_CF_*` set should not have to restart to see it. Construction is a
 * few object literals; nothing here opens a connection.
 */
export function hostedRuntimes(): HostedRuntime[] {
  return [
    new LocalRuntime(),
    new CloudflareRuntime({
      accountId: process.env.ZENITH_CF_ACCOUNT_ID,
      namespace: process.env.ZENITH_CF_NAMESPACE,
      // The one place this secret is read.
      token: process.env.ZENITH_CF_API_TOKEN,
      probeUrlTemplate: process.env.ZENITH_CF_PROBE_URL,
      brokerModulePath: process.env.ZENITH_CF_BROKER_MODULE,
    }),
  ];
}

/**
 * The runtime `ZENITH_RUNTIME` selects.
 *
 * Throws `runtime_unavailable` carrying the *reason* — which variable is
 * missing and what it is for — rather than a generic refusal, because the
 * caller is usually a screen that has to tell an operator what to do next.
 */
export function selectedHostedRuntime(): HostedRuntime {
  const wanted: RuntimeId = hostedConfig().ZENITH_RUNTIME;
  const runtime = hostedRuntimes().find((candidate) => candidate.id === wanted) as
    | SelectableRuntime
    | undefined;
  if (!runtime)
    throw new HostedError("runtime_unavailable", `There is no hosted runtime called "${wanted}".`, {
      fix: `Set ZENITH_RUNTIME to one of: ${hostedRuntimes().map((r) => r.id).join(", ")}.`,
    });
  const blocked = runtime.blockedReason();
  if (blocked) throw new HostedError("runtime_unavailable", blocked.reason, { fix: blocked.fix });
  return runtime;
}
