/**
 * C3 read() bridge for Azure: ACR supplies the upload location at build launch,
 * so prepare returns content metadata rather than uploading to S3/GCS. No
 * archives, credentials or signed URLs are retained outside the broker call.
 * startBuild rereads and verifies these bytes; a moving ref fails closed.
 */
import type { SourceBundlePort } from "@/lib/execution/ports";
import type { BuildPipelineSpec } from "@/lib/resources/specs";
import { sha256Hex } from "@/lib/controlplane/digest";
import { StepFailedError } from "@/lib/execution/errors";
import { MAX_SOURCE_BYTES } from "@/lib/providers/azure/acr-build";
import { context, managed } from "./support";

/** Structurally compatible with createSourceBundles(deps)'s C3 read method.
 * C3 is supplied by the source-bundle workstream, not implemented here.
 */
export interface AzureSourceReader {
  read(source: BuildPipelineSpec["source"], signal?: AbortSignal): Promise<{ archive: Uint8Array; sha256: string; bytes: number }>;
}

export async function readArchive(reader: AzureSourceReader, source: BuildPipelineSpec["source"], signal: AbortSignal): Promise<{ archive: Uint8Array; sha256: string; bytes: number }> {
  signal.throwIfAborted();
  if (!source || typeof source.repo !== "string" || !source.repo || typeof source.ref !== "string" || !source.ref) throw new StepFailedError("Azure build pipeline must identify its source repository and ref.");
  let result;
  try { result = await reader.read(source, signal); } catch { signal.throwIfAborted(); throw new Error("Azure source bundle could not be read; no build was launched."); }
  signal.throwIfAborted();
  if (!result || !(result.archive instanceof Uint8Array) || result.archive.byteLength === 0 || result.archive.byteLength > MAX_SOURCE_BYTES || result.bytes !== result.archive.byteLength || !/^[a-f0-9]{64}$/.test(result.sha256) || sha256Hex(result.archive) !== result.sha256) throw new StepFailedError("Source bundle bytes do not match the recorded digest/size bounds.");
  return result;
}

export function createSourceBundlePort(reader: AzureSourceReader): SourceBundlePort {
  return {
    async prepare(raw, input) {
      const ctx = context(raw); managed(ctx, input.service);
      const result = await readArchive(reader, input.source, ctx.signal);
      return { s3Key: `bundles/${result.sha256}.tar.gz`, digest: result.sha256 };
    },
  };
}
