/**
 * Build isolation profiles (PROD-LIFE-09).
 *
 * A source build runs code nobody at Zenith has read. Every provider's build
 * path therefore has ONE declared profile: what the build principal may be,
 * what it may reach, how long and how large it may run, and whether the source
 * can be modified. The profile is data; the enforcement points are the
 * provider adapters (compile output for AWS, the Cloud Build request for GCP,
 * the ACR run request for Azure) and this module's admission check, which
 * refuses to release an artifact whose OBSERVED build configuration falls
 * outside its profile.
 *
 * Honest scope. Two controls cannot be proven from the control plane on every
 * provider and the observation says exactly which mechanism backed them:
 *  - instance metadata: where the platform offers no switch to remove the
 *    endpoint (Cloud Build default pool, ACR Tasks) the profile accepts
 *    "exposes build identity only": the sole principal reachable through the
 *    metadata endpoint is the dedicated, least-privilege build identity and
 *    never a deployment credential;
 *  - egress: an allowlist needs customer network constructs (a VPC with a
 *    proxy, a private worker pool). Without them the build is recorded as
 *    `egress: "unrestricted"` and release admission REFUSES it unless the
 *    operator set an explicit, recorded open-egress exception.
 */
import { digest } from "@/lib/controlplane/digest";

export const BUILD_ISOLATION_VERSION = "zenith.build-isolation.v1" as const;

export type BuildProviderKey = "aws" | "gcp" | "azure" | "zenith";

export interface BuildIsolationProfile {
  id: string;
  provider: BuildProviderKey;
  /** hard upper bounds a build may run with */
  limits: { maxTimeoutSec: number; computeClasses: readonly string[] };
  /** if present, the build principal identifier must match */
  identityPattern?: RegExp;
  /** how each control is backed on this provider (documentation that ships in the statement) */
  mechanisms: { identity: string; metadata: string; network: string; dependencies: string; filesystem: string; resources: string };
}

export const BUILD_TIMEOUT_CEILING_SEC = 3600;

export const BUILD_ISOLATION_PROFILES: Readonly<Record<BuildProviderKey, BuildIsolationProfile>> = Object.freeze({
  aws: {
    id: "aws.codebuild.v1",
    provider: "aws",
    limits: { maxTimeoutSec: 1800, computeClasses: ["BUILD_GENERAL1_SMALL", "BUILD_GENERAL1_MEDIUM"] },
    identityPattern: /^arn:aws:iam::\d{12}:role\/zenith-[A-Za-z0-9+=,.@_-]{0,100}-build$/,
    mechanisms: {
      identity: "dedicated CodeBuild service role under the ZenithBuildBoundary permissions boundary; never the deploy role",
      metadata: "buildspec drops forwarded traffic to 169.254.169.254 and 169.254.170.2 before the Dockerfile runs and aborts if the rule is missing",
      network: "host firewall in the privileged build container: forwarded (Dockerfile RUN) traffic may reach only DNS and TCP 443 to the resolved allowlisted hosts; the executed buildspec is read back from the build and must equal the generated one",
      dependencies: "package registry hosts are an explicit allowlist (defaults plus spec.isolation.allowedHosts); everything else is rejected",
      filesystem: "S3 source object is read-only to the role (GetObject only); the bundle is addressed by digest",
      resources: "fixed compute class, 30 minute build timeout, 30 minute queue timeout, no auto retry",
    },
  },
  gcp: {
    id: "gcp.cloudbuild.v1",
    provider: "gcp",
    limits: { maxTimeoutSec: 1800, computeClasses: ["E2_MEDIUM", "E2_HIGHCPU_8", "e2-medium", "e2-standard-2", "e2-standard-4", "e2-highcpu-8"] },
    mechanisms: {
      identity: "per-pipeline build service account labelled to the pipeline; never the deploy account",
      metadata: "the metadata server exposes only the build service account token",
      network: "Cloud Build private worker pool with NO_PUBLIC_EGRESS; egress only through the pool's peered network",
      dependencies: "private pool network routes dependency downloads through the customer's allowlisted proxy",
      filesystem: "source object pinned by GCS generation; build workspace is ephemeral",
      resources: "fixed machine type, bounded timeout, disk size cap, VERIFIED provenance requested",
    },
  },
  azure: {
    id: "azure.acr-tasks.v1",
    provider: "azure",
    limits: { maxTimeoutSec: 1800, computeClasses: ["cpu-2"] },
    mechanisms: {
      identity: "ACR Tasks run with the registry task identity only; no managed identity is attached and no deploy credential is supplied",
      metadata: "the run exposes no user-assigned identity; the task agent has no access to deploy credentials",
      network: "ACR dedicated agent pool inside the customer's virtual network",
      dependencies: "agent pool network routes dependency downloads through the allowlisted proxy",
      filesystem: "source archive uploaded once to a registry-owned blob and consumed read-only",
      resources: "fixed 2 vCPU agent, bounded run timeout",
    },
  },
  zenith: {
    id: "zenith.k8s-build.v1",
    provider: "zenith",
    limits: { maxTimeoutSec: 1800, computeClasses: ["k8s-2cpu-4gi"] },
    identityPattern: /^system:serviceaccount:[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?:zenith-builder$/,
    mechanisms: {
      identity: "one Job in the platform build namespace under the dedicated zenith-builder ServiceAccount with no token mounted; its only Secrets are the immutable source bundle and the registry push credential, never a deploy credential",
      metadata: "the build namespace NetworkPolicy is read back after the build; no egress rule may cover the link-local metadata address",
      network: "the build namespace NetworkPolicy zenith-build-egress is read back after the build: egress is allowlisted only when no rule opens the public internet. Enforcement depends on the cluster's CNI, which the control plane cannot prove",
      dependencies: "dependency downloads are allowed only to the destinations the build namespace policy names",
      filesystem: "the source bundle is an immutable Secret mounted read-only and addressed by digest",
      resources: "fixed 2 CPU / 4 GiB limits, 1800 second active deadline, no retries",
    },
  },
});

export interface ObservedBuildIsolation {
  profileId: string;
  identity: { principal: string; dedicated: boolean; deployCredentials: "absent" | "present" | "unknown" };
  metadata: { exposes: "none" | "build_identity_only" | "unknown"; mechanism: string };
  network: { egress: "allowlisted" | "unrestricted"; verifiedBy?: "provider_read" | "compile_binding"; allowlistDigest?: string; mechanism: string };
  dependencies: { downloads: "allowlisted" | "direct" };
  filesystem: { sourceMount: "read_only" | "read_write" };
  resources: { timeoutSec: number; computeClass: string };
}

export interface BuildIsolationPolicy {
  /** operator exception: admit a build whose egress was not restricted. Recorded on the statement. */
  allowOpenEgress: boolean;
}

export class BuildIsolationError extends Error {
  readonly code = "build_isolation_violation";
  constructor(readonly violations: readonly string[]) {
    super(`The build ran outside its isolation profile: ${violations.join("; ")}.`);
    this.name = "BuildIsolationError";
  }
}

export function profileFor(provider: string): BuildIsolationProfile {
  const p = (BUILD_ISOLATION_PROFILES as Record<string, BuildIsolationProfile | undefined>)[provider];
  if (!p) throw new BuildIsolationError([`${provider} has no build isolation profile, so its source builds are refused`]);
  return p;
}

/** Digest an egress allowlist so a statement can bind it without carrying hostnames. */
export const allowlistDigest = (entries: readonly string[]): string => digest([...new Set(entries)].sort());

/**
 * Throws `BuildIsolationError` unless the observed configuration satisfies the
 * provider profile. Returns the recorded policy exceptions (never silent).
 */
export function assertBuildIsolation(provider: string, observed: ObservedBuildIsolation, policy: BuildIsolationPolicy): { exceptions: string[] } {
  const profile = profileFor(provider);
  const v: string[] = [];
  const exceptions: string[] = [];
  if (observed?.profileId !== profile.id) v.push("the observation names a different profile");
  if (!observed?.identity || !observed.identity.dedicated) v.push("the build did not run under a dedicated build identity");
  else if (observed.identity.deployCredentials !== "absent") v.push("deployment credentials were not shown to be absent from the build");
  if (observed?.identity && profile.identityPattern && !profile.identityPattern.test(observed.identity.principal)) v.push("the build principal is not a build role");
  if (!observed?.metadata || !["none", "build_identity_only"].includes(observed.metadata.exposes)) v.push("instance metadata exposure is not limited to the build identity");
  if (!observed?.filesystem || observed.filesystem.sourceMount !== "read_only") v.push("the source was not mounted read-only");
  if (!observed?.resources) v.push("resource bounds were not observed");
  else {
    const r = observed.resources;
    if (!Number.isInteger(r.timeoutSec) || r.timeoutSec <= 0 || r.timeoutSec > profile.limits.maxTimeoutSec) v.push("the build timeout is outside the profile bound");
    if (!profile.limits.computeClasses.includes(r.computeClass)) v.push("the build compute class is outside the profile");
  }
  if (!observed?.network) v.push("network egress was not observed");
  else if (observed.network.egress === "unrestricted") {
    if (policy.allowOpenEgress) exceptions.push("open_egress");
    else v.push("build egress was not restricted to the allowlisted registry/proxy set");
  } else if (!observed.network.allowlistDigest || !observed.network.verifiedBy) v.push("the egress allowlist is not bound to a verification");
  // Controlled downloads need a proxy; an admitted open-egress exception already covers direct ones.
  if (observed?.dependencies?.downloads !== "allowlisted" && !exceptions.includes("open_egress")) v.push("dependency downloads are not controlled");
  if (v.length) throw new BuildIsolationError(v);
  return { exceptions };
}

/**
 * The build context subdirectory of a pipeline (PROD-LIFE-09 / LIFE-08 handoff). Returns "." for the
 * repository root. Refuses absolute paths, backslashes, empty, "." and ".." segments and anything outside a
 * conservative character set, so the value is safe in argv and in buildspec text. That the directory EXISTS
 * at the approved commit, and that no symlink in it escapes the archive, is verified by source acquisition
 * (LIFE-08), which owns the archive; providers here only honor the validated value.
 */
export function normalizeContextDir(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "" || raw === ".") return ".";
  if (typeof raw !== "string" || raw.length > 200 || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(raw) || raw.split("/").some((s) => s === "." || s === "..")) {
    throw new BuildIsolationError(["source.contextDir must be a normalized relative directory inside the repository (letters, digits, . _ - and / separators; no '..', no absolute path)"]);
  }
  return raw;
}

/** Validated context dir of a pipeline spec, refusing unsupported builders and providers that cannot honor a subdirectory. */
export function contextDirOf(spec: { source?: { contextDir?: unknown; builder?: unknown } }, provider: BuildProviderKey): string {
  if (spec.source?.builder !== undefined && spec.source.builder !== "dockerfile") {
    throw new BuildIsolationError(["buildpack builds have no isolated builder; provide a Dockerfile (source.builder must be \"dockerfile\")"]);
  }
  const dir = normalizeContextDir(spec.source?.contextDir);
  // Azure honors a subdirectory by uploading an archive built only from it (azure/release/context-archive.ts).
  void provider;
  return dir;
}

/** Clamp helper for adapters: refuse a configured timeout outside the profile. */
export function boundedTimeoutSec(provider: BuildProviderKey, requested: number | undefined): number {
  const max = BUILD_ISOLATION_PROFILES[provider].limits.maxTimeoutSec;
  const t = requested ?? max;
  if (!Number.isInteger(t) || t < 60 || t > max) throw new BuildIsolationError([`timeout ${String(t)}s is outside 60-${max}s`]);
  return t;
}

/**
 * Facts the provider ADAPTER read back from the provider's own API after the
 * build finished. The control plane copies them into the provenance statement;
 * it does not invent them. `isolation` is what the executed build actually
 * carried, not what the request asked for.
 */
export interface BuildAttestation {
  /** stable id of the build service instance, e.g. a CodeBuild project ARN, a Cloud Build pool/project, an ACR registry id */
  builderId: string;
  /** the provider's build/run id */
  invocationId: string;
  /** toolchain image, digest pinned where the provider reports one */
  builderImage?: string;
  startedOn?: string;
  finishedOn?: string;
  isolation: ObservedBuildIsolation;
}
