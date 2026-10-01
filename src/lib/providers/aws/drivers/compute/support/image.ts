/**
 * Container image references.
 *
 * An image ref reaches a task definition (and so a container runtime) from the
 * manifest or from a build, so it is parsed against a conservative subset of
 * the OCI reference grammar and anything else is rejected, rather than passed
 * through to a template. A parsed ref is rebuilt from its parts; the original
 * string is never spliced anywhere.
 */

export class ImageRefError extends Error {
  readonly code = "invalid_image_ref";
  constructor(message: string) {
    super(message);
    this.name = "ImageRefError";
  }
}

export interface ParsedImage {
  /** `host[:port]` when the first path component is a registry host */
  host?: string;
  /** repository path without host, e.g. `acme/api` */
  repository: string;
  tag?: string;
  digest?: string;
  /** canonical text rebuilt from the parts */
  ref: string;
}

const COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?$/;

export function parseImageRef(input: unknown): ParsedImage {
  if (typeof input !== "string" || input.length === 0 || input.length > 255) throw new ImageRefError("image reference must be a string of 1-255 characters.");
  if (!/^[A-Za-z0-9._\-/:@]+$/.test(input)) throw new ImageRefError("image reference contains characters outside [A-Za-z0-9._-/:@].");
  let rest = input;
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) throw new ImageRefError("image digest must be sha256:<64 hex>.");
  }
  let tag: string | undefined;
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.indexOf(":", lastSlash + 1);
  if (colon >= 0) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) throw new ImageRefError("image tag is not valid.");
  }
  const parts = rest.split("/");
  let host: string | undefined;
  if (parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost")) {
    host = parts.shift();
    if (!host || !HOST.test(host)) throw new ImageRefError("image registry host is not valid.");
  }
  if (parts.length === 0 || !parts.every((p) => COMPONENT.test(p))) throw new ImageRefError("image repository path is not valid (lowercase letters, digits, . _ - and / only).");
  const repository = parts.join("/");
  const ref = `${host ? `${host}/` : ""}${repository}${tag ? `:${tag}` : ""}${digest ? `@${digest}` : ""}`;
  return { ...(host ? { host } : {}), repository, ...(tag ? { tag } : {}), ...(digest ? { digest } : {}), ref };
}

export interface EcrImage {
  account: string;
  region: string;
  repository: string;
}

/** `123456789012.dkr.ecr.eu-west-1.amazonaws.com/acme/api:tag` → its ECR coordinates. */
export function ecrCoordinates(image: ParsedImage): EcrImage | undefined {
  const m = image.host ? /^(\d{12})\.dkr\.ecr(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(image.host) : null;
  return m ? { account: m[1], region: m[2], repository: image.repository } : undefined;
}
