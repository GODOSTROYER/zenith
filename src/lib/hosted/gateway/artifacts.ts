/**
 * Serving one file of the active release's artifact — step 9, and the first
 * step that touches anything the app produced.
 *
 * Everything here runs *after* admission. That is the whole point of the
 * ordering: `HEAD`, a byte range and a hashed asset are the three ways a
 * careless gateway leaks content to someone it already decided to refuse, so
 * all three are implemented on this side of the fence and the invocation
 * sentinel counts every one of them.
 *
 * Workstream W6 (hosted R3).
 */
import type { NextRequest } from "next/server";
import { HostedError, type ArtifactFile } from "@/lib/hosted/contracts";
import type { AdmittedRequest } from "./admission";
import { gatewayDeps } from "./deps";
import { gatewayResponse, isHashedAssetPath } from "./guard";
import { noteArtifactServed } from "./telemetry";

/** The SPA rule: a path whose last segment has no extension is an app route, not a file. */
export function artifactTargetFor(path: string): string {
  if (path === "") return "index.html";
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 ? path : "index.html";
}

/** One satisfiable byte range, or the reason there is not one. */
type RangeVerdict =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "range"; start: number; end: number };

/**
 * Parse a single byte range.
 *
 * Only one range is honoured: a multipart range response is a second body
 * format to get right for no benefit an app of this shape can use, so a
 * multi-range request is answered 416 with the size, which tells the client
 * exactly how to ask again.
 */
export function parseByteRange(header: string | null, size: number): RangeVerdict {
  if (header === null) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: "invalid" };
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return { kind: "invalid" };

  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0 || size === 0) return { kind: "invalid" };
    return { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return { kind: "invalid" };
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(end) || end < start) return { kind: "invalid" };
  return { kind: "range", start, end: Math.min(end, size - 1) };
}

/**
 * Does `if-none-match` already hold this exact entity?
 *
 * The tag is the file's SHA-256, so a match is a proof of identical bytes
 * rather than a heuristic. `W/` prefixes are tolerated because caches add them;
 * `*` matches anything, as the specification says.
 */
export function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === "*") return true;
  return trimmed
    .split(",")
    .map((tag) => tag.trim().replace(/^W\//, ""))
    .includes(etag);
}

/** The refusal a request for a file this release does not contain gets. */
const notInRelease = (): HostedError =>
  new HostedError("not_found", "This app has no page or file at that address.", {
    fix: "Check the link. If it came from inside the app, the app may be pointing at a file its last build did not produce.",
  });

/**
 * Serve one file of the admitted release.
 *
 * The bytes are read only once every check above has passed; `noteArtifactServed`
 * is called at that moment and nowhere else, so a denial test that asserts the
 * counter is zero is asserting that no artifact was ever opened.
 */
export async function serveArtifact(
  req: NextRequest,
  path: string,
  admitted: AdmittedRequest
): Promise<Response> {
  const target = artifactTargetFor(path);
  const opened = await gatewayDeps().artifactStore().open(admitted.digest, target);
  if (!opened) throw notInRelease();
  noteArtifactServed();

  const { bytes, file } = opened;
  const etag = `"${file.sha256}"`;
  const cache = isHashedAssetPath(target) ? "immutable" : "no-store";
  const releaseId = admitted.release.id;
  const head = req.method.toUpperCase() === "HEAD";

  if (matchesEtag(req.headers.get("if-none-match"), etag))
    return gatewayResponse(null, {
      status: 304,
      cache,
      releaseId,
      headers: { etag, "accept-ranges": "bytes" },
    });

  const range = parseByteRange(req.headers.get("range"), bytes.length);
  if (range.kind === "invalid")
    return gatewayResponse(null, {
      status: 416,
      cache: "no-store",
      releaseId,
      headers: { "content-range": `bytes */${bytes.length}`, "accept-ranges": "bytes", etag },
    });

  if (range.kind === "range") {
    const slice = bytes.subarray(range.start, range.end + 1);
    return gatewayResponse(head ? null : new Uint8Array(slice), {
      status: 206,
      cache,
      releaseId,
      headers: {
        ...contentHeaders(file, slice.length),
        etag,
        "accept-ranges": "bytes",
        "content-range": `bytes ${range.start}-${range.end}/${bytes.length}`,
      },
    });
  }

  return gatewayResponse(head ? null : new Uint8Array(bytes), {
    cache,
    releaseId,
    headers: { ...contentHeaders(file, bytes.length), etag, "accept-ranges": "bytes" },
  });
}

/**
 * The content headers.
 *
 * `content-length` is set explicitly, including on `HEAD`, because a HEAD that
 * does not say how big the thing is has told the caller nothing they could not
 * have guessed. The type comes from the artifact manifest's allowlist, never
 * from the file's bytes.
 */
function contentHeaders(file: ArtifactFile, length: number): Record<string, string> {
  return { "content-type": file.contentType, "content-length": String(length) };
}
