/**
 * Cloud Build helpers for `build_pipeline` (ADR-0016 on GCP).
 *
 * Source builds execute hostile code, so they run in the CUSTOMER's project,
 * under a dedicated build service account that can only read the source
 * bundle, push to the named Artifact Registry repository and write logs.
 * Zenith uploads a source bundle to the pipeline's bucket and starts a build
 * through `builds.create` with a `storageSource`; it never builds in the
 * control plane's process and never holds a repository credential.
 *
 * Safety of inputs: bucket, object, image reference, Dockerfile path and
 * service account are each validated against a strict pattern before they go
 * into a request; build arguments are an argv array (never a shell string);
 * the Dockerfile is passed as `--file=<path>` so a path can never be parsed as
 * a flag.
 *
 * Idempotency: Cloud Build has no client token. Every build is tagged
 * `zenith-op-<hash of operation id>`; before creating, the helper looks for a
 * build with that tag and returns it instead of starting a second one.
 *
 * The caller gets the image DIGEST from `getBuild` (recorded and verified
 * before deploy, per ADR-0016), not just a tag.
 */
import { fnv6 } from "../../naming";
import { gcpCall, gcpGet } from "../../rest";
import type { GcpDriverContext } from "../../types";
import { SA_EMAIL_RE } from "../../validate";
import { BUILD_ISOLATION_PROFILES } from "@/lib/execution/build-isolation";

/** Isolation defaults (PROD-LIFE-09): fixed machine type, capped disk, bounded timeout. */
export const CLOUD_BUILD_MACHINE_TYPE = "E2_MEDIUM";
export const CLOUD_BUILD_DISK_GB = 100;
export const CLOUD_BUILD_DEFAULT_TIMEOUT_SEC = 1200;
const WORKER_POOL = new RegExp("^projects/[a-z][a-z0-9-]{4,28}[a-z0-9]/locations/[a-z0-9-]{2,40}/workerPools/[a-z][a-z0-9-]{0,62}$");

/** gcr.io/cloud-builders/docker:latest; registry HEAD resolved by the orchestrator
 * on 2026-10-01 (Docker-Content-Digest, single-platform Docker v2 manifest).
 * Image pull and Cloud Build execution have not been live-verified here.
 */
export const CLOUD_BUILD_DOCKER_IMAGE = "gcr.io/cloud-builders/docker@sha256:40c2fb4fcd0ad51376eef166c2e7b2b40a3508d5776e2bf33db3783ab39d0f2e";

const CLOUDBUILD = "https://cloudbuild.googleapis.com/v1";
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const OBJECT = /^[A-Za-z0-9][A-Za-z0-9._=+@/-]{0,1023}$/;
const DOCKERFILE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BUILD_ID = /^[0-9a-f-]{8,64}$/;

export interface StartBuildInput {
  sourceBucket: string;
  /** the uploaded source bundle (tar.gz) */
  sourceObject: string;
  sourceGeneration?: string;
  /** full image reference `<region>-docker.pkg.dev/<project>/<repo>/<image>[:tag]` in the session's project */
  imageRef: string;
  /** the pipeline's build service account email (a tofu output of the pipeline node) */
  buildServiceAccount: string;
  dockerfile?: string;
  /** build context subdirectory of the source bundle (validated by `contextDirOf`); default `.` */
  contextDir?: string;
  timeoutSeconds?: number;
  /** Cloud Build private pool (`projects/<p>/locations/<r>/workerPools/<name>`) that carries the egress restriction */
  workerPool?: string;
}

export interface BuildResult {
  ok: boolean;
  summary: string;
  buildId?: string;
  reused?: boolean;
  requestIds: string[];
}

function imageRefPattern(projectId: string): RegExp {
  const p = projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^[a-z0-9-]{2,40}-docker\\.pkg\\.dev/${p}/[a-z][a-z0-9-]{0,62}/[a-z0-9][a-z0-9._/-]{0,200}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$`);
}

function invalid(summary: string): BuildResult {
  return { ok: false, summary, requestIds: [] };
}

export function validateBuildInput(projectId: string, i: StartBuildInput): string | undefined {
  if (!BUCKET.test(i.sourceBucket)) return "sourceBucket is not a bucket name.";
  if (!OBJECT.test(i.sourceObject) || i.sourceObject.split("/").some((seg) => seg === ".." || seg === ".")) return "sourceObject is not a safe object name.";
  if (i.sourceGeneration !== undefined && !/^\d{1,20}$/.test(i.sourceGeneration)) return "sourceGeneration must be digits.";
  if (!imageRefPattern(projectId).test(i.imageRef)) return `imageRef must be an Artifact Registry Docker reference in project ${projectId}.`;
  if (!SA_EMAIL_RE.test(i.buildServiceAccount)) return "buildServiceAccount is not a service account email.";
  if (i.dockerfile !== undefined && (!DOCKERFILE.test(i.dockerfile) || i.dockerfile.split("/").includes(".."))) return "dockerfile must be a relative path inside the bundle.";
  const maxTimeout = BUILD_ISOLATION_PROFILES.gcp.limits.maxTimeoutSec;
  if (i.timeoutSeconds !== undefined && (!Number.isInteger(i.timeoutSeconds) || i.timeoutSeconds < 60 || i.timeoutSeconds > maxTimeout)) return `timeoutSeconds must be 60-${maxTimeout}.`;
  if (i.workerPool !== undefined && (!WORKER_POOL.test(i.workerPool) || !i.workerPool.startsWith(`projects/${projectId}/`))) return `workerPool must be a Cloud Build worker pool of project ${projectId}.`;
  return undefined;
}

export const opTag = (operationId: string): string => `zenith-op-${fnv6(operationId)}${fnv6(`${operationId}\0b`)}`;

/** Start (or find) the build for this operation. */
export async function startBuild(ctx: GcpDriverContext, input: StartBuildInput): Promise<BuildResult> {
  const op = ctx.operationId;
  if (!op || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(op)) return invalid("build needs an operation id so a retry cannot start a second build.");
  const bad = validateBuildInput(ctx.session.projectId, input);
  if (bad) return invalid(`build: ${bad}`);
  const base = `${CLOUDBUILD}/projects/${ctx.session.projectId}/locations/${ctx.region}/builds`;
  const tag = opTag(op);

  const existing = await gcpGet(ctx, `${base}?pageSize=1&filter=${encodeURIComponent(`tags="${tag}"`)}`);
  // if we cannot tell whether this operation already started a build, do not risk a second one
  if (existing.outcome !== "ok") {
    return { ok: false, summary: `build: could not check for an existing build of this operation (${existing.outcome}${existing.detail ? `: ${existing.detail}` : ""}).`, requestIds: existing.requestId ? [existing.requestId] : [] };
  }
  const prior = Array.isArray(existing.json.builds) ? (existing.json.builds[0] as Record<string, unknown> | undefined) : undefined;
  if (prior && typeof prior.id === "string" && BUILD_ID.test(prior.id)) {
    return { ok: true, summary: "A build for this operation already exists.", buildId: prior.id, reused: true, requestIds: existing.requestId ? [existing.requestId] : [] };
  }

  const dockerfile = input.dockerfile ?? "Dockerfile";
  const body = {
    source: { storageSource: { bucket: input.sourceBucket, object: input.sourceObject, ...(input.sourceGeneration ? { generation: input.sourceGeneration } : {}) } },
    steps: [{ name: CLOUD_BUILD_DOCKER_IMAGE, args: ["build", `--file=${dockerfile}`, `--tag=${input.imageRef}`, input.contextDir ?? "."] }],
    images: [input.imageRef],
    serviceAccount: `projects/${ctx.session.projectId}/serviceAccounts/${input.buildServiceAccount}`,
    options: {
      logging: "CLOUD_LOGGING_ONLY",
      // the builder attests the build with Google-signed provenance; the control plane records what it observed
      requestedVerifyOption: "VERIFIED",
      diskSizeGb: CLOUD_BUILD_DISK_GB,
      ...(input.workerPool ? { pool: { name: input.workerPool } } : { machineType: CLOUD_BUILD_MACHINE_TYPE }),
    },
    timeout: `${input.timeoutSeconds ?? CLOUD_BUILD_DEFAULT_TIMEOUT_SEC}s`,
    tags: ["zenith", tag],
  };
  const res = await gcpCall(ctx, "POST", base, body);
  if (res.outcome !== "ok") return { ok: false, summary: `build: Cloud Build rejected the request (${res.outcome}${res.detail ? `: ${res.detail}` : ""}).`, requestIds: res.requestId ? [res.requestId] : [] };
  const meta = res.json.metadata as Record<string, unknown> | undefined;
  const build = meta?.build as Record<string, unknown> | undefined;
  const id = typeof build?.id === "string" && BUILD_ID.test(build.id) ? build.id : undefined;
  return {
    ok: id !== undefined,
    summary: id ? "Started a build in the customer project." : "Cloud Build accepted the request but returned no build id.",
    ...(id ? { buildId: id } : {}),
    requestIds: [res.requestId, typeof res.json.name === "string" ? res.json.name : undefined].filter((x): x is string => !!x),
  };
}

export interface BuildStatus {
  status: "QUEUED" | "WORKING" | "SUCCESS" | "FAILURE" | "INTERNAL_ERROR" | "TIMEOUT" | "CANCELLED" | "EXPIRED" | "PENDING" | "STATUS_UNKNOWN" | "UNKNOWN";
  done: boolean;
  success: boolean;
  images: { name: string; digest: string }[];
  requestId?: string;
  outcome: "ok" | "missing" | "inaccessible" | "throttled" | "error";
}

const TERMINAL = new Set(["SUCCESS", "FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"]);

/** Read a build's status and the image digests it produced. */
export async function getBuild(ctx: GcpDriverContext, buildId: string): Promise<BuildStatus> {
  if (!BUILD_ID.test(buildId)) return { status: "UNKNOWN", done: false, success: false, images: [], outcome: "error" };
  const res = await gcpGet(ctx, `${CLOUDBUILD}/projects/${ctx.session.projectId}/locations/${ctx.region}/builds/${buildId}`);
  if (res.outcome !== "ok") return { status: "UNKNOWN", done: false, success: false, images: [], requestId: res.requestId, outcome: res.outcome };
  const raw = typeof res.json.status === "string" ? res.json.status : "STATUS_UNKNOWN";
  const status = (["QUEUED", "WORKING", "SUCCESS", "FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED", "PENDING"].includes(raw) ? raw : "STATUS_UNKNOWN") as BuildStatus["status"];
  const results = res.json.results as Record<string, unknown> | undefined;
  const images = (Array.isArray(results?.images) ? (results!.images as Record<string, unknown>[]) : [])
    .map((i) => ({ name: String(i.name ?? ""), digest: String(i.digest ?? "") }))
    .filter((i) => i.name !== "" && DIGEST.test(i.digest));
  return { status, done: TERMINAL.has(status), success: status === "SUCCESS", images, requestId: res.requestId, outcome: "ok" };
}
