/**
 * Exact-resource AddSecretVersion delivery. Compare latest content hashes only
 * in memory: an operation marker would ignore a rotation within that operation.
 * Access is limited to this secret's latest version by the caller's grant.
 * After an ambiguous add, retries re-read latest instead of trusting a marker.
 * HTTP bodies/errors/version ids from the provider are never forwarded raw.
 * Contract-tested HTTP only. Environment lease serializes Zenith writers;
 * Google offers no compare-and-swap on AddSecretVersion against foreign writers.
 */
import type { GcpSession } from "@/lib/credentials/types";
import type { ResourceNode } from "@/lib/resources/types";
import { gcpLabels } from "./naming";
import { crc32c } from "./drivers/data/secret-manager-secret";
import { sameSecret, SecretDeliveryError, secretFailure, type SecretTenant, type SecretWriteResult } from "@/lib/secrets/delivery";

export async function writeGcpSecret(session: GcpSession, input: SecretTenant & {
  node: ResourceNode; secretId: string; resolve(): Promise<string | undefined>; signal?: AbortSignal;
}): Promise<SecretWriteResult> {
  let bytes: Buffer | undefined;
  const base = `https://secretmanager.googleapis.com/v1/${input.secretId}`;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(session.projectId) || !new RegExp(`^projects/${session.projectId}/secrets/[A-Za-z0-9_-]{1,255}$`).test(input.secretId) || input.node.provider !== "gcp" || input.node.ownership !== "managed") throw new SecretDeliveryError("denied");
    const request = async (url: string, init?: RequestInit): Promise<Response> => {
      const r = await session.authorizedFetch(url, { ...init, signal: input.signal, redirect: "error" });
      return r;
    };
    const metadata = await request(base);
    if (!metadata.ok) throw secretFailure({ status: metadata.status });
    const target = await metadata.json() as { name?: unknown; labels?: Record<string, unknown> };
    const labels = gcpLabels({ "zenith:managed": "true", "zenith:workspace": input.workspaceId, "zenith:environment": input.environmentId, "zenith:resource": input.node.address });
    if (target.name !== input.secretId || Object.entries(labels).some(([k, v]) => target.labels?.[k] !== v)) throw new SecretDeliveryError("denied");
    const value = await input.resolve();
    if (value === undefined) throw new SecretDeliveryError("missing");
    bytes = Buffer.from(value, "utf8");
    if (!bytes.length || bytes.length > 65536) throw new SecretDeliveryError("invalid");
    const current = await request(`${base}/versions/latest:access`);
    if (current.ok) {
      const body = await current.json() as { payload?: { data?: unknown; dataCrc32c?: unknown }; name?: unknown };
      if (typeof body.payload?.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.payload.data)) throw new SecretDeliveryError("unreachable");
      const prior = Buffer.from(body.payload.data, "base64");
      try {
        if (body.payload.dataCrc32c !== undefined && String(body.payload.dataCrc32c) !== String(crc32c(prior))) throw new SecretDeliveryError("unreachable");
        if (sameSecret(prior, bytes)) return { changed: false, versionId: versionId(body.name, input.secretId) };
      } finally { prior.fill(0); }
    } else if (current.status !== 404) throw secretFailure({ status: current.status });
    const result = await request(`${base}:addVersion`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: { data: bytes.toString("base64"), dataCrc32c: String(crc32c(bytes)) } }) });
    if (!result.ok) throw secretFailure({ status: result.status });
    const body = await result.json() as { name?: unknown };
    return { changed: true, versionId: versionId(body.name, input.secretId) };
  } catch (err) { throw secretFailure(err); }
  finally { bytes?.fill(0); }
}

function versionId(name: unknown, secretId: string): string {
  if (typeof name !== "string" || !name.startsWith(`${secretId}/versions/`) || !/^[1-9][0-9]{0,19}$/.test(name.slice(`${secretId}/versions/`.length))) throw new SecretDeliveryError("unreachable");
  return name.slice(`${secretId}/versions/`.length);
}
