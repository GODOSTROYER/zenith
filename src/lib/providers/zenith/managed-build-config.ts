/**
 * Configuration of the managed BUILD path (PROD-MAN-01). Kept apart from the
 * substrate reader so the pinned substrate variable list is untouched; the same
 * discipline applies: one function reads the environment, a bad value makes the
 * build path unavailable and names the variable, nothing half-configures.
 *
 * A source build runs code nobody at Zenith has read, so the builder is an
 * operator-chosen, DIGEST-PINNED image. There is no default builder image:
 * choosing the toolchain that executes tenant Dockerfiles is a decision the
 * operator records, not one this code makes for them.
 */
import type { ZenithEnv } from "./substrate";

export const BUILD_ENV_VARS = [
  "ZENITH_MANAGED_BUILD_NAMESPACE",
  "ZENITH_MANAGED_BUILDER_IMAGE",
  "ZENITH_MANAGED_BUILD_PUSH_SECRET",
  "ZENITH_MANAGED_BUILD_REGISTRY_INSECURE",
] as const;

export interface ManagedBuildConfig {
  /** platform namespace builds run in; never a tenant namespace */
  namespace: string;
  /** digest-pinned builder (kaniko-compatible CLI) */
  builderImage: string;
  /** name of a `kubernetes.io/dockerconfigjson` Secret in the build namespace the builder pushes with */
  pushSecret?: string;
  /** pass `--insecure` to the builder: a plain-http registry (local kind only) */
  insecureRegistry: boolean;
  serviceAccount: string;
}

export type ManagedBuildConfigResult =
  | { configured: true; config: ManagedBuildConfig }
  | { configured: false; reason: string };

/** Name of the platform build ServiceAccount (no token mounted, no role bindings). */
export const BUILD_SERVICE_ACCOUNT = "zenith-builder";
/** Name of the default-deny/egress NetworkPolicy the build namespace baseline must carry. */
export const BUILD_EGRESS_POLICY = "zenith-build-egress";
export const DEFAULT_BUILD_NAMESPACE = "zenith-build";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PINNED_IMAGE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?(\/[a-z0-9._-]+)+(:[A-Za-z0-9_.-]{1,128})?@sha256:[0-9a-f]{64}$/;

export function readBuildConfig(env: ZenithEnv): ManagedBuildConfigResult {
  const raw = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };
  const image = raw("ZENITH_MANAGED_BUILDER_IMAGE");
  if (image === undefined) {
    return { configured: false, reason: "Managed builds are not configured: set ZENITH_MANAGED_BUILDER_IMAGE to a digest-pinned builder image (<registry>/<repo>@sha256:<64 hex>)." };
  }
  if (!PINNED_IMAGE.test(image)) {
    return { configured: false, reason: "ZENITH_MANAGED_BUILDER_IMAGE must be pinned by digest (<registry>/<repo>@sha256:<64 hex>); a tag is mutable and is refused." };
  }
  const namespace = raw("ZENITH_MANAGED_BUILD_NAMESPACE") ?? DEFAULT_BUILD_NAMESPACE;
  if (!LABEL.test(namespace)) return { configured: false, reason: "ZENITH_MANAGED_BUILD_NAMESPACE must be a DNS-1123 label." };
  const pushSecret = raw("ZENITH_MANAGED_BUILD_PUSH_SECRET");
  if (pushSecret !== undefined && !LABEL.test(pushSecret)) return { configured: false, reason: "ZENITH_MANAGED_BUILD_PUSH_SECRET must be a Secret name (DNS-1123 label)." };
  const insecureRaw = raw("ZENITH_MANAGED_BUILD_REGISTRY_INSECURE");
  if (insecureRaw !== undefined && insecureRaw !== "0" && insecureRaw !== "1") return { configured: false, reason: 'ZENITH_MANAGED_BUILD_REGISTRY_INSECURE must be "0" or "1".' };
  return {
    configured: true,
    config: { namespace, builderImage: image, ...(pushSecret ? { pushSecret } : {}), insecureRegistry: insecureRaw === "1", serviceAccount: BUILD_SERVICE_ACCOUNT },
  };
}
