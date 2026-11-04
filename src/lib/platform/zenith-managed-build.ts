/**
 * Source builds on the Zenith-operated cluster (PROD-MAN-01): the BuildPort and
 * the source hand-off for `provider = zenith`.
 *
 * This is the managed-substrate half of the LIFE-08/LIFE-09 path, not a second
 * one. Everything before and after it is the existing release machinery:
 *
 *   LIFE-08  approved source snapshot (immutable GitHub commit, archive digest)
 *            -> `SourceBundlePort.prepare` (platform/source-bundle.ts, zenith branch)
 *            -> `createZenithSourceStore().upload` below
 *   build    `createZenithBuildPort().startBuild/waitForBuild` below: ONE
 *            Kubernetes Job in the platform build namespace, pushing to the
 *            Zenith-operated registry, returning the digest the builder wrote
 *   LIFE-09  `BuildAttestation` read back from the executed Job + the build
 *            namespace's NetworkPolicy -> `assertBuildIsolation` ->
 *            signed provenance -> release (execution/release.ts, unchanged)
 *
 * Isolation honesty (what the profile `zenith.k8s-build.v1` claims and does not):
 *   - identity: the Job runs as the dedicated `zenith-builder` ServiceAccount with
 *     no token mounted; the only Secrets it sees are the immutable source bundle
 *     and (optionally) the registry push credential, never a deploy credential.
 *   - network: egress is whatever the build namespace's `zenith-build-egress`
 *     NetworkPolicy allows, READ BACK at attestation time. A policy that allows
 *     the public internet is reported `unrestricted` and release admission
 *     refuses it unless the operator recorded the open-egress exception. That a
 *     NetworkPolicy is ENFORCED depends on the cluster's CNI; this code reads the
 *     policy, it cannot prove the CNI honors it.
 *   - the builder is the operator's digest-pinned image; tenant Dockerfiles run
 *     as root inside it (kaniko needs it). A kernel or runtime escape defeats all
 *     of this: stronger isolation (sandboxed runtime) is PROD-MAN-04's evaluation.
 *   - source is handed over as an immutable Secret (<= ~700 KiB). Larger sources
 *     refuse by name; they need object storage (PROD-MAN-03).
 */
import { digest } from "@/lib/controlplane/digest";
import type { DriverContext } from "@/lib/drivers/types";
import { StepFailedError } from "@/lib/execution/errors";
import type { BuildHandle, BuildPort, BuildResult } from "@/lib/execution/ports";
import { allowlistDigest, BUILD_ISOLATION_PROFILES, boundedTimeoutSec, contextDirOf, type BuildAttestation } from "@/lib/execution/build-isolation";
import { createK8sClient, listByKind, readObject, READ_ONLY_KINDS, ownedBy, toK8sError, type K8sClient } from "@/lib/providers/kubernetes/client";
import { ANNOTATION, LABEL, MANAGED_BY_VALUE, type K8sObject } from "@/lib/providers/kubernetes/types";
import { deepEqual, dig, isRecord, redactText, truncate } from "@/lib/providers/kubernetes/util";
import { ApiException, type KubernetesObject } from "@kubernetes/client-node";
import { assertSessionMatches, type ZenithSession } from "@/lib/providers/zenith/session";
import { BUILD_EGRESS_POLICY, type ManagedBuildConfig } from "@/lib/providers/zenith/managed-build-config";
import { ManagedSubstrateError, type ManagedSubstratePort } from "@/lib/providers/zenith/managed-port";
import { serviceLabelOf } from "@/lib/providers/zenith/substrate";
import type { BuildPipelineSpec } from "@/lib/resources/specs";

/* -------------------------------- constants -------------------------------- */

const FIELD_MANAGER = "zenith-build";
const WORKSPACE_ANNOTATION = "zenith.dev/workspace-id";
const BUILD_KEY_ANNOTATION = "zenith.dev/build-key";
const SOURCE_DIGEST_ANNOTATION = "zenith.dev/source-digest";
const IMAGE_ANNOTATION = "zenith.dev/build-image";
const BUILD_LABEL = "zenith.dev/build";
const SOURCE_FILE = "source.tar.gz";
const SOURCE_MOUNT = "/source";

/** Largest source archive the in-cluster hand-off carries (a Secret is limited to 1 MiB after base64). */
export const MAX_INCLUSTER_SOURCE_BYTES = 700 * 1024;
export const ZENITH_BUILD_COMPUTE_CLASS = "k8s-2cpu-4gi";
export const BUILD_LIMITS = Object.freeze({ cpu: "2", memory: "4Gi", ephemeralStorage: "10Gi" });
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const JOB_NAME = /^zbuild-[a-f0-9]{40}$/;
const SOURCE_SECRET = /^zsrc-[a-f0-9]{40}$/;

/* ----------------------------- source hand-off ----------------------------- */

export interface ZenithSourceStore {
  /** Store the immutable bundle where the build Job mounts it; returns the object name (idempotent on content). */
  upload(ctx: DriverContext, bundle: { archive: Uint8Array; sha256: string; bytes: number }): Promise<{ name: string; namespace: string }>;
}

/** Secret name for one environment's copy of one bundle. Environment-scoped: two tenants never share a source object. */
export const sourceSecretName = (environmentId: string, sha256: string): string => `zsrc-${digest(["zenith-source", environmentId, sha256]).slice(0, 40)}`;

export function createZenithSourceStore(managed: ManagedSubstratePort): ZenithSourceStore {
  return {
    async upload(ctx, bundle) {
      if (!HEX64.test(bundle.sha256) || bundle.bytes !== bundle.archive.length) throw new StepFailedError("The source bundle identity is malformed.");
      if (bundle.bytes > MAX_INCLUSTER_SOURCE_BYTES) {
        throw new StepFailedError(`The source archive is ${bundle.bytes} bytes; the managed in-cluster build hand-off carries at most ${MAX_INCLUSTER_SOURCE_BYTES}. Reduce the source (a smaller context directory) or wait for managed object storage.`);
      }
      const name = sourceSecretName(ctx.environmentId, bundle.sha256);
      try {
        return await managed.withBuildSession({ workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, signal: ctx.signal }, async (session, namespace) => {
          const client = createK8sClient(session, { signal: ctx.signal });
          await client.guard.assert(namespace);
          const secret = {
            apiVersion: "v1", kind: "Secret",
            metadata: {
              name, namespace,
              labels: { [LABEL.managedBy]: MANAGED_BY_VALUE },
              annotations: { [ANNOTATION.environment]: ctx.environmentId, [WORKSPACE_ANNOTATION]: ctx.workspaceId, [SOURCE_DIGEST_ANNOTATION]: bundle.sha256 },
            },
            type: "Opaque", immutable: true,
            data: { [SOURCE_FILE]: Buffer.from(bundle.archive).toString("base64") },
          } as unknown as KubernetesObject;
          try {
            await client.objects.create(secret, undefined, undefined, FIELD_MANAGER);
          } catch (e) {
            if (!(e instanceof ApiException) || e.code !== 409) throw e;
            const live = await readObject(client, { apiVersion: "v1", kind: "Secret", namespace, name });
            if (!live || !ownedBy(live, ctx.environmentId).owned || dig(live, "metadata", "annotations", SOURCE_DIGEST_ANNOTATION) !== bundle.sha256) {
              throw new StepFailedError("A source object with this name exists but is not this environment's copy of this bundle.");
            }
          }
          return { name, namespace };
        });
      } catch (e) {
        if (e instanceof StepFailedError) throw e;
        if (e instanceof ManagedSubstrateError) throw new StepFailedError(e.message);
        const code = toK8sError(e).code;
        if (["forbidden", "unauthorized", "invalid", "bad_input", "namespace_forbidden", "session_invalid", "not_found"].includes(code)) throw new StepFailedError(`The source hand-off was refused by the managed cluster (${code}).`);
        throw new Error("Source hand-off could not be confirmed; outcome is unknown.");
      }
    },
  };
}

/* ------------------------------- the Job spec ------------------------------ */

export interface BuildJobInput {
  config: ManagedBuildConfig;
  workspaceId: string;
  environmentId: string;
  serviceAddress: string;
  pipelineAddress: string;
  key: string;
  /** `<repository>:zn-<key40>` */
  image: string;
  sourceSecret: string;
  sourceDigest: string;
  /** Dockerfile path relative to the context directory */
  dockerfile: string;
  contextDir: string;
  timeoutSec: number;
}

/** Arguments of the builder (kaniko-compatible CLI). Pure. */
export function builderArgs(input: Pick<BuildJobInput, "config" | "image" | "dockerfile" | "contextDir">): string[] {
  const args = [
    `--context=tar://${SOURCE_MOUNT}/${SOURCE_FILE}`,
    `--dockerfile=${input.dockerfile}`,
    `--destination=${input.image}`,
    "--digest-file=/dev/termination-log",
    "--cache=false",
    "--no-push-cache",
  ];
  if (input.contextDir !== ".") args.splice(1, 0, `--context-sub-path=${input.contextDir}`);
  if (input.config.insecureRegistry) args.push("--insecure");
  return args;
}

export const jobNameFor = (key: string): string => `zbuild-${key.slice(0, 40)}`;

/** The Job exactly as submitted. Pure; read back and compared at attestation. */
export function renderBuildJob(input: BuildJobInput): K8sObject {
  const name = jobNameFor(input.key);
  const volumes: Record<string, unknown>[] = [{ name: "source", secret: { secretName: input.sourceSecret, defaultMode: 0o444 } }];
  const mounts: Record<string, unknown>[] = [{ name: "source", mountPath: SOURCE_MOUNT, readOnly: true }];
  if (input.config.pushSecret) {
    volumes.push({ name: "registry-auth", secret: { secretName: input.config.pushSecret, items: [{ key: ".dockerconfigjson", path: "config.json" }], defaultMode: 0o444 } });
    mounts.push({ name: "registry-auth", mountPath: "/kaniko/.docker", readOnly: true });
  }
  const ownership = {
    [ANNOTATION.environment]: input.environmentId,
    [ANNOTATION.resource]: input.serviceAddress,
    [WORKSPACE_ANNOTATION]: input.workspaceId,
    [BUILD_KEY_ANNOTATION]: input.key,
    [SOURCE_DIGEST_ANNOTATION]: input.sourceDigest,
    [IMAGE_ANNOTATION]: input.image,
    "zenith.dev/pipeline": input.pipelineAddress,
  };
  return {
    apiVersion: "batch/v1", kind: "Job",
    metadata: { name, namespace: input.config.namespace, labels: { [LABEL.managedBy]: MANAGED_BY_VALUE, [BUILD_LABEL]: name }, annotations: ownership },
    spec: {
      completions: 1, parallelism: 1, backoffLimit: 0,
      activeDeadlineSeconds: input.timeoutSec, ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: { [LABEL.managedBy]: MANAGED_BY_VALUE, [BUILD_LABEL]: name }, annotations: ownership },
        spec: {
          serviceAccountName: input.config.serviceAccount,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          restartPolicy: "Never",
          securityContext: { seccompProfile: { type: "RuntimeDefault" } },
          containers: [{
            name: "build", image: input.config.builderImage, args: builderArgs(input),
            securityContext: { allowPrivilegeEscalation: false, privileged: false },
            resources: {
              requests: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "2Gi" },
              limits: { cpu: BUILD_LIMITS.cpu, memory: BUILD_LIMITS.memory, "ephemeral-storage": BUILD_LIMITS.ephemeralStorage },
            },
            volumeMounts: mounts, terminationMessagePath: "/dev/termination-log", terminationMessagePolicy: "File",
          }],
          volumes,
        },
      },
    },
  } as K8sObject;
}

/* ------------------------------ egress policy ------------------------------ */

export interface EgressReading {
  egress: "allowlisted" | "unrestricted";
  /** a rule permits link-local addresses (the instance metadata endpoint) */
  metadataReachable: boolean;
  rules: unknown;
}

const OPEN_CIDRS = new Set(["0.0.0.0/0", "::/0"]);

function ipv4ToInt(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m || [m[1], m[2], m[3], m[4]].some((o) => Number(o) > 255)) return undefined;
  return (((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0);
}

/** Does an IPv4 CIDR (minus its `except` entries) contain 169.254.169.254? Other families are treated as not containing it. */
function coversMetadata(cidr: string, except: readonly string[]): boolean {
  const target = ipv4ToInt("169.254.169.254") as number;
  const inCidr = (c: string): boolean => {
    const [ip, bits] = c.split("/");
    const base = ipv4ToInt(ip ?? "");
    const n = Number(bits);
    if (base === undefined || !Number.isInteger(n) || n < 0 || n > 32) return false;
    const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
    return (target & mask) >>> 0 === (base & mask) >>> 0;
  };
  return inCidr(cidr) && !except.some(inCidr);
}

/** Read a NetworkPolicy object as an egress statement. A missing or non-egress policy is unrestricted. */
export function classifyBuildEgress(policy: Record<string, unknown> | undefined): EgressReading {
  if (!policy) return { egress: "unrestricted", metadataReachable: true, rules: null };
  const types = dig(policy, "spec", "policyTypes");
  if (!Array.isArray(types) || !types.includes("Egress")) return { egress: "unrestricted", metadataReachable: true, rules: null };
  const rules = dig(policy, "spec", "egress");
  const list = Array.isArray(rules) ? rules : [];
  let open = false;
  let metadata = false;
  for (const rule of list) {
    if (!isRecord(rule)) { open = true; continue; }
    const to = rule.to;
    // a rule with no peers allows every destination (on its ports)
    if (!Array.isArray(to) || to.length === 0) { open = true; metadata = true; continue; }
    for (const peer of to) {
      if (!isRecord(peer)) { open = true; continue; }
      const block = peer.ipBlock;
      if (isRecord(block) && typeof block.cidr === "string") {
        const except = Array.isArray(block.except) ? block.except.filter((e): e is string => typeof e === "string") : [];
        if (OPEN_CIDRS.has(block.cidr)) open = true;
        if (coversMetadata(block.cidr, except)) metadata = true;
      }
    }
  }
  return { egress: open ? "unrestricted" : "allowlisted", metadataReachable: metadata, rules: list };
}

/* ------------------------------- attestation ------------------------------- */

const quantityIs = (value: unknown, ...allowed: string[]): boolean => typeof value === "string" && allowed.includes(value);

/** The compute class a Job's limits correspond to; anything else is `k8s-unrecognised` (refused by the profile). */
export function computeClassOf(job: Record<string, unknown>): string {
  const limits = dig(job, "spec", "template", "spec", "containers", 0, "resources", "limits");
  if (isRecord(limits) && quantityIs(limits.cpu, "2", "2000m") && quantityIs(limits.memory, "4Gi", "4096Mi")) return ZENITH_BUILD_COMPUTE_CLASS;
  return "k8s-unrecognised";
}

/** What the executed Job and the build namespace's policy say about isolation. Pure over the readings. */
export function attestBuild(input: { config: ManagedBuildConfig; job: Record<string, unknown>; egress: EgressReading; serviceAccountExists: boolean }): BuildAttestation {
  const { config, job, egress } = input;
  const profile = BUILD_ISOLATION_PROFILES.zenith;
  const spec = dig(job, "spec", "template", "spec");
  const container = dig(spec, "containers", 0);
  const mounts = dig(container, "volumeMounts");
  const sourceMount = Array.isArray(mounts) ? mounts.find((m) => isRecord(m) && m.name === "source") : undefined;
  const volumes = dig(spec, "volumes");
  const secretNames = (Array.isArray(volumes) ? volumes : []).flatMap((v) => (isRecord(v) && isRecord(v.secret) && typeof v.secret.secretName === "string" ? [v.secret.secretName] : []));
  const otherSecrets = secretNames.filter((n) => !SOURCE_SECRET.test(n) && n !== config.pushSecret);
  const noToken = dig(spec, "automountServiceAccountToken") === false;
  const dedicated = dig(spec, "serviceAccountName") === config.serviceAccount && input.serviceAccountExists;
  const timeoutSec = dig(job, "spec", "activeDeadlineSeconds");
  const started = dig(job, "status", "startTime");
  const finished = dig(job, "status", "completionTime");
  const allowlisted = egress.egress === "allowlisted";
  return {
    builderId: `zenith-managed:${config.namespace}`,
    invocationId: String(dig(job, "metadata", "uid") ?? ""),
    builderImage: typeof dig(container, "image") === "string" ? (dig(container, "image") as string) : undefined,
    ...(typeof started === "string" ? { startedOn: started } : {}),
    ...(typeof finished === "string" ? { finishedOn: finished } : {}),
    isolation: {
      profileId: profile.id,
      identity: {
        principal: `system:serviceaccount:${config.namespace}:${String(dig(spec, "serviceAccountName") ?? "")}`,
        dedicated,
        deployCredentials: noToken && otherSecrets.length === 0 ? "absent" : "unknown",
      },
      metadata: { exposes: egress.metadataReachable ? "unknown" : "none", mechanism: profile.mechanisms.metadata },
      network: allowlisted
        ? { egress: "allowlisted", verifiedBy: "provider_read", allowlistDigest: allowlistDigest([digest(egress.rules)]), mechanism: profile.mechanisms.network }
        : { egress: "unrestricted", mechanism: `the build namespace policy ${BUILD_EGRESS_POLICY} permits public destinations, or is absent` },
      dependencies: { downloads: allowlisted ? "allowlisted" : "direct" },
      filesystem: { sourceMount: isRecord(sourceMount) && sourceMount.readOnly === true ? "read_only" : "read_write" },
      resources: { timeoutSec: typeof timeoutSec === "number" ? timeoutSec : 0, computeClass: computeClassOf(job) },
    },
  };
}

/* --------------------------------- handles --------------------------------- */

interface Handle {
  version: 1;
  /** provider id for readback and ledger receipts: the Job name */
  id: string;
  scope: string;
  namespace: string;
  key: string;
  image: string;
  repository: string;
  service: string;
  sourceSecret: string;
  sourceDigest: string;
  dockerfile: string;
  contextDir: string;
}

const scopeOf = (ctx: Pick<DriverContext, "workspaceId" | "environmentId">): string => digest([ctx.workspaceId, ctx.environmentId]);

function decode(ctx: DriverContext, config: ManagedBuildConfig, raw: string): Handle {
  let h: Handle;
  try {
    if (typeof raw !== "string" || raw.length > 6000) throw new Error();
    h = JSON.parse(raw) as Handle;
    if (!h || typeof h !== "object" || Array.isArray(h)) throw new Error();
  } catch { throw new StepFailedError("Invalid managed build handle."); }
  if (h.version !== 1 || h.scope !== scopeOf(ctx) || h.namespace !== config.namespace || !HEX64.test(h.key) || h.id !== jobNameFor(h.key) || !JOB_NAME.test(h.id)
    || typeof h.image !== "string" || typeof h.repository !== "string" || !h.image.startsWith(`${h.repository}:zn-`) || !SOURCE_SECRET.test(h.sourceSecret)
    || !HEX64.test(h.sourceDigest) || typeof h.dockerfile !== "string" || typeof h.contextDir !== "string") {
    throw new StepFailedError("The managed build handle is outside this environment or malformed.");
  }
  return h;
}

/* -------------------------------- the port --------------------------------- */

const asZenithSession = (ctx: DriverContext): ZenithSession => {
  const session = ctx.session as Partial<ZenithSession> | undefined;
  if (ctx.provider !== "zenith" || session?.provider !== "zenith" || !session.tenant || !session.substrate) throw new StepFailedError("Managed builds require a Zenith-managed session.");
  assertSessionMatches(session as ZenithSession, ctx);
  return session as ZenithSession;
};

/** Context directory and Dockerfile as the builder sees them (Dockerfile relative to the context). */
export function builderPaths(spec: BuildPipelineSpec, contextDir: string): { dockerfile: string; contextDir: string } {
  const dockerfile = spec.source.dockerfile ?? "Dockerfile";
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(dockerfile) || dockerfile.split("/").some((s) => s === "." || s === "..")) throw new StepFailedError("The Dockerfile path is not a normalized relative path.");
  if (contextDir === ".") return { dockerfile, contextDir };
  const prefix = `${contextDir}/`;
  if (!dockerfile.startsWith(prefix)) throw new StepFailedError("The Dockerfile must be inside the build context directory.");
  return { dockerfile: dockerfile.slice(prefix.length), contextDir };
}

export interface ZenithBuildPortOptions {
  managed: ManagedSubstratePort;
  /** poll interval for the Job; default 1000 ms */
  pollMs?: number;
}

type StartInput = Parameters<BuildPort["startBuild"]>[1];

export function createZenithBuildPort(options: ZenithBuildPortOptions): BuildPort {
  const { managed } = options;
  const pollMs = options.pollMs ?? 1000;

  function configOf(): ManagedBuildConfig {
    try { return managed.buildConfig(); }
    catch (e) { throw e instanceof ManagedSubstrateError ? new StepFailedError(e.message) : e; }
  }

  async function prepare(ctx: DriverContext, input: StartInput) {
    const session = asZenithSession(ctx);
    const registry = managed.registry();
    if (!registry) throw new StepFailedError("Managed builds need a Zenith-operated registry (ZENITH_MANAGED_REGISTRY).");
    const config = configOf();
    if (input.service.provider !== "zenith" || input.service.ownership !== "managed" || !["container_service", "scheduled_job"].includes(input.service.kind)) throw new StepFailedError("Build target must be a managed Zenith workload.");
    if (input.pipeline.provider !== "zenith" || input.pipeline.ownership !== "managed" || input.pipeline.kind !== "build_pipeline") throw new StepFailedError("Build pipeline must be a managed Zenith pipeline.");
    const artifact = input.service.spec.artifact as { type?: string; pipeline?: string; registry?: string } | undefined;
    const spec = input.pipeline.spec as unknown as BuildPipelineSpec;
    if (artifact?.type !== "built" || artifact.pipeline !== input.pipeline.address || !("registry" in (spec.output ?? {})) || !input.idempotencyKey) throw new StepFailedError("Build inputs do not identify this workload's pipeline.");
    if (artifact.registry !== undefined && (spec.output as { registry: string }).registry !== artifact.registry) throw new StepFailedError("The pipeline output registry does not match the workload's.");
    if (!HEX64.test(input.source.digest)) throw new StepFailedError("The source digest is malformed.");
    const sourceSecret = input.source.s3Key;
    if (sourceSecret !== sourceSecretName(ctx.environmentId, input.source.digest) || input.source.bucket !== config.namespace) {
      throw new StepFailedError("The source object is not this environment's hand-off for this digest.");
    }
    const contextDir = contextDirOf(spec, "zenith");
    const paths = builderPaths(spec, contextDir);
    const service = serviceLabelOf(input.service.address);
    const repository = registry.repositoryFor(session.tenant, service);
    const key = digest([scopeOf(ctx), input.service.address, input.pipeline.address, input.source.digest, input.idempotencyKey]);
    const image = `${repository}:zn-${key.slice(0, 40)}`;
    const job = renderBuildJob({
      config, workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, serviceAddress: input.service.address, pipelineAddress: input.pipeline.address,
      key, image, sourceSecret, sourceDigest: input.source.digest, dockerfile: paths.dockerfile, contextDir: paths.contextDir, timeoutSec: boundedTimeoutSec("zenith", undefined),
    });
    const handle: Handle = { version: 1, id: jobNameFor(key), scope: scopeOf(ctx), namespace: config.namespace, key, image, repository, service, sourceSecret, sourceDigest: input.source.digest, dockerfile: paths.dockerfile, contextDir: paths.contextDir };
    return { config, job, handle, key };
  }

  /** The platform baseline must exist before any tenant Dockerfile runs. */
  async function assertBaseline(client: K8sClient, config: ManagedBuildConfig): Promise<void> {
    const account = await readObject(client, { apiVersion: "v1", kind: "ServiceAccount", namespace: config.namespace, name: config.serviceAccount });
    if (!account) throw new StepFailedError(`The build namespace baseline is missing the ${config.serviceAccount} ServiceAccount; apply deploy/zenith-managed first.`);
    if (dig(account, "automountServiceAccountToken") !== false) throw new StepFailedError(`The ${config.serviceAccount} ServiceAccount must set automountServiceAccountToken: false.`);
    const policy = await readObject(client, { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", namespace: config.namespace, name: BUILD_EGRESS_POLICY });
    if (!policy) throw new StepFailedError(`The build namespace has no ${BUILD_EGRESS_POLICY} NetworkPolicy; apply deploy/zenith-managed first. Builds do not run without a declared egress policy.`);
  }

  async function launch(ctx: DriverContext, input: StartInput): Promise<BuildHandle> {
    const p = await prepare(ctx, input);
    try {
      await managed.withBuildSession({ workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, signal: ctx.signal }, async (session, namespace) => {
        if (namespace !== p.config.namespace) throw new StepFailedError("The build session is outside the build namespace.");
        const client = createK8sClient(session, { signal: ctx.signal });
        await client.guard.assert(namespace);
        await assertBaseline(client, p.config);
        const source = await readObject(client, { apiVersion: "v1", kind: "Secret", namespace, name: p.handle.sourceSecret });
        if (!source || !ownedBy(source, ctx.environmentId).owned || dig(source, "metadata", "annotations", SOURCE_DIGEST_ANNOTATION) !== p.handle.sourceDigest) {
          throw new StepFailedError("The source object is absent or is not this environment's copy of the approved bundle.");
        }
        try {
          await client.objects.create(p.job as unknown as KubernetesObject, undefined, undefined, FIELD_MANAGER);
        } catch (e) {
          if (!(e instanceof ApiException) || e.code !== 409) throw e;
          const live = await readObject(client, { apiVersion: "batch/v1", kind: "Job", namespace, name: p.handle.id });
          verifyJob(p.config, ctx, live, p.handle);
        }
      });
    } catch (e) {
      if (e instanceof StepFailedError) throw e;
      if (e instanceof ManagedSubstrateError) throw new StepFailedError(e.message);
      const code = toK8sError(e).code;
      if (["forbidden", "unauthorized", "invalid", "bad_input", "namespace_forbidden", "session_invalid", "not_found"].includes(code)) throw new StepFailedError(`The managed build was refused by the cluster (${code}).`);
      throw new Error("Managed build launch could not be confirmed; reconcile before retrying.");
    }
    return { buildId: JSON.stringify(p.handle) };
  }

  /** The Job found under the claimed name must be exactly this launch (annotations, image, args, identity). */
  function verifyJob(config: ManagedBuildConfig, ctx: DriverContext, live: Record<string, unknown> | undefined, handle: Handle): void {
    if (!live) throw new Error("The claimed build Job is absent; its outcome is unknown and it will not be relaunched.");
    const note = (k: string) => dig(live, "metadata", "annotations", k);
    const container = dig(live, "spec", "template", "spec", "containers", 0);
    const expectedArgs = builderArgs({ config, image: handle.image, dockerfile: handle.dockerfile, contextDir: handle.contextDir });
    if (!ownedBy(live, ctx.environmentId).owned || note(WORKSPACE_ANNOTATION) !== ctx.workspaceId || note(BUILD_KEY_ANNOTATION) !== handle.key || note(SOURCE_DIGEST_ANNOTATION) !== handle.sourceDigest || note(IMAGE_ANNOTATION) !== handle.image
      || dig(container, "image") !== config.builderImage || !deepEqual(dig(container, "args"), expectedArgs)
      || dig(live, "spec", "template", "spec", "serviceAccountName") !== config.serviceAccount || dig(live, "spec", "template", "spec", "automountServiceAccountToken") !== false
      || dig(live, "spec", "backoffLimit") !== 0 || dig(live, "spec", "completions") !== 1) {
      throw new StepFailedError("The build Job does not match the claimed launch.");
    }
  }

  async function readDigest(client: K8sClient, namespace: string, job: Record<string, unknown>): Promise<string | undefined> {
    const uid = dig(job, "metadata", "uid");
    if (typeof uid !== "string") return undefined;
    const pods = await listByKind(client, READ_ONLY_KINDS.Pod, namespace, { labelSelector: `batch.kubernetes.io/controller-uid=${uid}`, limit: 20, maxPages: 1 });
    const owned = pods.items.filter((p) => {
      const owners = dig(p, "metadata", "ownerReferences");
      return Array.isArray(owners) && owners.some((o) => isRecord(o) && o.kind === "Job" && o.uid === uid && o.controller === true);
    });
    if (pods.truncated || owned.length !== 1) return undefined;
    const statuses = dig(owned[0], "status", "containerStatuses");
    const status = Array.isArray(statuses) ? statuses.find((c) => isRecord(c) && c.name === "build") : undefined;
    if (dig(status, "state", "terminated", "exitCode") !== 0) return undefined;
    const message = dig(status, "state", "terminated", "message");
    const value = typeof message === "string" ? message.trim() : "";
    return SHA256_DIGEST.test(value) ? value : undefined;
  }

  async function wait(ctx: DriverContext, built: BuildHandle, opts: { timeoutMs: number }): Promise<BuildResult> {
    asZenithSession(ctx);
    const config = configOf();
    const handle = decode(ctx, config, built.buildId);
    const deadline = Date.now() + opts.timeoutMs;
    return managed.withBuildSession({ workspaceId: ctx.workspaceId, environmentId: ctx.environmentId, signal: ctx.signal }, async (session, namespace) => {
      const client = createK8sClient(session, { signal: ctx.signal });
      await client.guard.assert(namespace);
      const ref = { apiVersion: "batch/v1", kind: "Job", namespace, name: handle.id };
      let uid: string | undefined;
      for (;;) {
        const job = await readObject(client, ref);
        if (!job) throw new Error("The claimed build Job is absent; its outcome is unknown.");
        verifyJob(config, ctx, job, handle);
        const current = dig(job, "metadata", "uid");
        if (typeof current !== "string" || (uid && current !== uid)) throw new Error("The build Job was replaced; its outcome is unknown.");
        uid = current;
        const conditions = dig(job, "status", "conditions");
        const complete = Array.isArray(conditions) && conditions.some((c) => isRecord(c) && c.type === "Complete" && c.status === "True");
        const failed = Array.isArray(conditions) && conditions.some((c) => isRecord(c) && c.type === "Failed" && c.status === "True");
        if (complete && failed) throw new Error("The build Job reports both Complete and Failed; its outcome is unknown.");
        if (failed) {
          const reason = conditions.find((c: unknown) => isRecord(c) && c.type === "Failed") as Record<string, unknown>;
          await dropSource(client, namespace, handle.sourceSecret);
          return { status: reason.reason === "DeadlineExceeded" ? "timed_out" : "failed", detail: truncate(redactText(`build Job failed: ${String(reason.reason ?? "unknown")}`), 200) } satisfies BuildResult;
        }
        if (complete) {
          const imageDigest = await readDigest(client, namespace, job);
          if (!imageDigest) throw new Error("The build Job completed without a readable image digest; its outcome is unknown.");
          const egress = classifyBuildEgress(await readObject(client, { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", namespace, name: BUILD_EGRESS_POLICY }));
          const account = await readObject(client, { apiVersion: "v1", kind: "ServiceAccount", namespace, name: config.serviceAccount });
          const attestation = attestBuild({ config, job, egress, serviceAccountExists: account !== undefined && dig(account, "automountServiceAccountToken") === false });
          await dropSource(client, namespace, handle.sourceSecret);
          return { status: "succeeded", digest: imageDigest, imageUri: `${handle.repository}@${imageDigest}`, attestation } satisfies BuildResult;
        }
        if (Date.now() >= deadline) return { status: "timed_out", detail: "waiting for the build Job timed out; the Job keeps its own deadline" };
        await new Promise<void>((resolve, reject) => {
          if (ctx.signal.aborted) return reject(new Error("The build wait ended; its outcome is unknown."));
          const timer = setTimeout(resolve, pollMs);
          ctx.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("The build wait ended; its outcome is unknown.")); }, { once: true });
        });
      }
    });
  }

  async function dropSource(client: K8sClient, namespace: string, name: string): Promise<void> {
    try { await client.objects.delete({ apiVersion: "v1", kind: "Secret", metadata: { name, namespace } } as KubernetesObject); } catch { /* best effort: the Secret is immutable, labelled and bounded */ }
  }

  return {
    startBuild: launch,
    waitForBuild: wait,
    launchIdentity(ctx, input) {
      const key = digest([scopeOf(ctx), input.service.address, input.pipeline.address, input.source.digest, input.idempotencyKey]);
      return { job: jobNameFor(key), namespace: configOf().namespace };
    },
    async adoptBuild(ctx, input, providerBuildId) {
      if (!JOB_NAME.test(providerBuildId)) throw new StepFailedError("The confirmed build Job name is malformed.");
      const p = await prepare(ctx, input);
      if (p.handle.id !== providerBuildId) throw new StepFailedError("The confirmed build Job does not belong to this launch.");
      return { buildId: JSON.stringify(p.handle) };
    },
  };
}

