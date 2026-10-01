/**
 * Image references: what a workload runs, and pinning it to a digest.
 *
 * A manifest service with an `image` source names a mutable tag
 * (`123456789012.dkr.ecr.us-east-1.amazonaws.com/api:prod`). Deploying a tag
 * means "whatever the tag points at when the task starts", which is not what was
 * reviewed. For images in the connection's OWN private ECR registry (same
 * account, same region) the digest is resolved with `ecr:DescribeImages` using
 * the brokered session and the deploy uses `repo@sha256:…`. Anything else — a
 * public registry, another account, another region — is kept as written and
 * reported as NOT PINNED (`digest: ""`): Zenith cannot read those registries
 * with the customer's credentials, and it says so instead of guessing.
 */
import { DescribeImagesCommand, ECRClient } from "@aws-sdk/client-ecr";
import type { ProviderSession } from "@/lib/credentials/types";
import { StepFailedError } from "./errors";
import { errorCode } from "./errors";
import { safeText } from "./text";

export const SHA256_IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

const ECR_REF = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9][a-z0-9._/-]*?)(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?:@(sha256:[0-9a-f]{64}))?$/;

export interface ParsedImageRef {
  ref: string;
  ecr?: { accountId: string; region: string; repository: string; tag?: string; digest?: string };
  /** `sha256:…` when the reference already pins one */
  pinnedDigest?: string;
}

export function parseImageRef(ref: string): ParsedImageRef {
  const pinned = /@(sha256:[0-9a-f]{64})$/.exec(ref)?.[1];
  const m = ECR_REF.exec(ref);
  if (!m) return { ref, ...(pinned ? { pinnedDigest: pinned } : {}) };
  return { ref, ...(pinned ? { pinnedDigest: pinned } : {}), ecr: { accountId: m[1], region: m[2], repository: m[3], ...(m[4] ? { tag: m[4] } : {}), ...(m[5] ? { digest: m[5] } : {}) } };
}

export interface PinnedImage {
  imageUri: string;
  /** `sha256:…`, or "" when the image could not be pinned */
  digest: string;
  /** why it is not pinned, when it is not */
  note?: string;
}

/** Resolve an image reference to a digest where Zenith can; otherwise keep it and say it is not pinned. */
export async function pinImage(session: ProviderSession, ref: string, signal?: AbortSignal): Promise<PinnedImage> {
  const parsed = parseImageRef(ref);
  if (parsed.pinnedDigest) return { imageUri: ref, digest: parsed.pinnedDigest };
  const ecr = parsed.ecr;
  if (!ecr) return { imageUri: ref, digest: "", note: "not pinned: the image is not in an ECR registry of the connected account" };
  if (session.provider !== "aws" || ecr.accountId !== session.accountId || ecr.region !== session.region) {
    return { imageUri: ref, digest: "", note: "not pinned: the image is in a registry outside the connected account or region" };
  }
  if (!ecr.tag) return { imageUri: ref, digest: "", note: "not pinned: the reference names neither a tag nor a digest" };
  try {
    const client = session.client(ECRClient);
    const out = await client.send(new DescribeImagesCommand({ registryId: ecr.accountId, repositoryName: ecr.repository, imageIds: [{ imageTag: ecr.tag }] }), { abortSignal: signal });
    const digest = out.imageDetails?.[0]?.imageDigest;
    if (!digest || !SHA256_IMAGE_DIGEST.test(digest)) return { imageUri: ref, digest: "", note: "not pinned: ECR did not return a digest for the tag" };
    const base = ref.slice(0, ref.length - ecr.tag.length - 1);
    return { imageUri: `${base}@${digest}`, digest };
  } catch (err) {
    const name = (err as { name?: string })?.name ?? errorCode(err);
    if (name === "ImageNotFoundException" || name === "RepositoryNotFoundException") {
      throw new StepFailedError(`The image ${safeText(ref, 200)} does not exist in the registry; build or push it, or correct the reference.`);
    }
    if (name === "AccessDeniedException") return { imageUri: ref, digest: "", note: "not pinned: the deploy role may not read the registry" };
    throw err;
  }
}
