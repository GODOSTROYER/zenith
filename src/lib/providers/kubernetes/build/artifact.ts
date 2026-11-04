import { createHash } from "node:crypto";
import { StepFailedError } from "@/lib/execution/errors";
import { dig, isRecord } from "../util";
import type { IsolatedBuildConfig } from "./config";

const SHA = /^sha256:[a-f0-9]{64}$/;
const sha = (bytes: Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
export interface RegistryReader { read(path: string): Promise<Uint8Array> }
/** Verify bytes, index-to-platform-to-attestation links, SLSA version and builder identity.
 * The existing LIFE-09 control-plane signature then binds reviewed source and image index.
 */
export async function verifyPublishedArtifact(reader: RegistryReader, imageDigest: string, builderId: string): Promise<string> {
  if (!SHA.test(imageDigest)) throw new StepFailedError("The build output digest is invalid.");
  const read = async (path: string, expected: string): Promise<Record<string, unknown>> => {
    if (!SHA.test(expected)) throw new StepFailedError("Registry descriptors must be digest-pinned.");
    const bytes = await reader.read(path);
    if (bytes.length > 1024 * 1024 || sha(bytes) !== expected) throw new StepFailedError("Registry artifact bytes do not match their digest.");
    let raw: unknown;
    try { raw = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new StepFailedError("Registry artifact is not bounded JSON."); }
    if (!isRecord(raw)) throw new StepFailedError("Registry artifact is malformed.");
    return raw;
  };
  const index = await read("manifests/" + imageDigest, imageDigest);
  if (index.schemaVersion !== 2 || index.mediaType !== "application/vnd.oci.image.index.v1+json" || !Array.isArray(index.manifests) || index.manifests.length !== 2) throw new StepFailedError("One platform image and one provenance attestation are required.");
  const image = index.manifests.find(m => isRecord(m) && dig(m, "platform", "os") === "linux" && ["arm64", "amd64"].includes(String(dig(m, "platform", "architecture"))));
  if (!isRecord(image) || typeof image.digest !== "string" || !SHA.test(image.digest)) throw new StepFailedError("The platform image descriptor is invalid.");
  const attested = index.manifests.find(m => isRecord(m) && dig(m, "annotations", "vnd.docker.reference.type") === "attestation-manifest" && dig(m, "annotations", "vnd.docker.reference.digest") === image.digest);
  if (!isRecord(attested) || typeof attested.digest !== "string") throw new StepFailedError("The registry index has no bound provenance attestation.");
  // Verify both referenced manifest byte streams, not a tag or returned protocol flag.
  const workload = await read("manifests/" + image.digest, image.digest);
  if (workload.schemaVersion !== 2 || !Array.isArray(workload.layers)) throw new StepFailedError("The published workload manifest is invalid.");
  const manifest = await read("manifests/" + attested.digest, attested.digest);
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers) || manifest.layers.length !== 1) throw new StepFailedError("The provenance manifest is invalid.");
  const layer = manifest.layers[0];
  if (!isRecord(layer) || typeof layer.digest !== "string" || layer.mediaType !== "application/vnd.in-toto+json" || dig(layer, "annotations", "in-toto.io/predicate-type") !== "https://slsa.dev/provenance/v1") throw new StepFailedError("SLSA v1 provenance is required.");
  const statement = await read("blobs/" + layer.digest, layer.digest);
  const subjects = statement.subject;
  if (statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== "https://slsa.dev/provenance/v1" || !Array.isArray(subjects) || subjects.length !== 1 || dig(subjects[0], "digest", "sha256") !== image.digest.slice(7) || dig(statement, "predicate", "runDetails", "builder", "id") !== builderId) throw new StepFailedError("The published provenance names a different artifact or builder.");
  const definition = dig(statement, "predicate", "buildDefinition");
  if (!isRecord(definition) || typeof definition.buildType !== "string" || !definition.buildType.startsWith("https://github.com/moby/buildkit/") || !Array.isArray(definition.resolvedDependencies) || definition.resolvedDependencies.some(d => !isRecord(d) || !isRecord(d.digest) || Object.keys(d.digest).length === 0 || !Object.values(d.digest).every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)))) throw new StepFailedError("BuildKit provenance dependencies are not digest-pinned.");
  return layer.digest;
}

/** Registry auth is deterministic and separate from deployment credentials. Bearer redirects are refused.
 * This reader never contacts an origin outside the configured exact registry destination.
 */
export function createRegistryReader(config: IsolatedBuildConfig, repository: string, dockerConfig?: unknown, signal?: AbortSignal): RegistryReader {
  const slash = repository.indexOf("/"), authority = repository.slice(0, slash), repo = repository.slice(slash + 1);
  const registry = new URL("https://" + authority);
  const destination = config.proxy.destinations.find(d => d.host === registry.hostname && d.port === Number(registry.port || "443"));
  if (slash < 1 || !destination || !/^[a-z0-9._/-]+$/.test(repo)) throw new StepFailedError("The registry repository is outside the build policy.");
  let authorization: string | undefined;
  if (dockerConfig !== undefined) {
    const auth = dig(dockerConfig, "auths", authority, "auth");
    if (typeof auth !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(auth) || !Buffer.from(auth, "base64").toString("utf8").includes(":")) throw new StepFailedError("The registry push Secret has no exact registry authentication.");
    authorization = "Basic " + auth;
  }
  const origin = (destination.tls ? "https://" : "http://") + authority;
  return { async read(path) {
    if (!/^(manifests|blobs)\/sha256:[a-f0-9]{64}$/.test(path)) throw new StepFailedError("Registry reads must use immutable digests.");
    const response = await fetch(origin + "/v2/" + repo + "/" + path, { redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      headers: { Accept: "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.in-toto+json", ...(authorization ? { Authorization: authorization } : {}) },
    }).catch(() => { throw new StepFailedError("Registry artifact readback could not be confirmed."); });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 1024 * 1024) { await response.body?.cancel(); throw new StepFailedError("Registry readback requires a bounded successful response; bearer challenges need an owned registry credential adapter."); }
    const stream = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const next = await stream.read(); if (next.done) break; bytes += next.value.length; if (bytes > 1024 * 1024) throw new StepFailedError("Registry artifact exceeds its size limit."); chunks.push(next.value); } }
    finally { await stream.cancel(); stream.releaseLock(); }
    return Buffer.concat(chunks);
  } };
}

