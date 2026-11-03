/**
 * GitHub intake: fetch `https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>`
 * and hand the bytes to the same bounded tarball reader as an upload.
 *
 * Handling of the optional token:
 *  - it is sent only as an `Authorization` header, only to
 *    `codeload.github.com`, and never appears in a URL, error message, log or
 *    the returned snapshot;
 *  - redirects are followed by hand (max 3) and only to GitHub-owned hosts;
 *    the token is NOT forwarded to a redirect target.
 *
 * The response body is read chunk by chunk and abandoned the moment it passes
 * the compressed-size cap, so a hostile or huge repository cannot make this
 * function buffer more than the cap.
 *
 * Not verified against live GitHub in this repository's tests (they inject
 * `fetchImpl`): private-repository access through codeload with a bearer
 * token is GitHub's documented behaviour, but no request was made here.
 */
import { snapshotFromTarball } from "./snapshot";
import { AnalysisInputError, DEFAULT_SNAPSHOT_LIMITS, type RepoSnapshot, type SnapshotLimits } from "./types";

export interface GithubSnapshotRequest {
  owner: string;
  repo: string;
  ref: string;
  token?: string;
  fetchImpl?: typeof fetch;
  limits?: Partial<SnapshotLimits>;
  /** Wall-clock cap for the whole download. Default 60 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Retain bounded documentation/tests as untrusted evidence for an agent, never as deployable roots. */
  includeEvidence?: boolean;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REF_SEGMENT = /^[A-Za-z0-9._+@~-]{1,100}$/;
const MAX_REDIRECTS = 3;

const isGithubHost = (host: string): boolean =>
  host === "codeload.github.com" || host === "github.com" || host === "api.github.com" || host.endsWith(".githubusercontent.com");

function validateCoordinates(owner: string, repo: string, ref: string): string[] {
  if (!OWNER.test(owner)) throw new AnalysisInputError("invalid_coordinates", "The GitHub owner name is not valid.");
  if (!REPO.test(repo) || repo === "." || repo === "..") throw new AnalysisInputError("invalid_coordinates", "The GitHub repository name is not valid.");
  const segments = ref.split("/");
  if (ref.length === 0 || ref.length > 250 || segments.some((s) => s === "" || s === "." || s === ".." || !REF_SEGMENT.test(s)))
    throw new AnalysisInputError("invalid_coordinates", "The git ref is not valid (letters, digits and . _ + @ ~ - separated by slashes).");
  return segments;
}

function duringDownload<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener("abort", stop); reject(new AnalysisInputError("fetch_failed", "The GitHub download could not be completed.")); };
    signal.addEventListener("abort", stop, { once: true });
    pending.then(value => { signal.removeEventListener("abort", stop); if (signal.aborted) stop(); else resolve(value); }, stop);
    if (signal.aborted) stop();
  });
}

async function readCapped(res: Response, cap: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    void res.body?.cancel().catch(() => undefined);
    throw new AnalysisInputError("compressed_too_large", `The repository archive is ${declared} bytes; the ceiling is ${cap}.`);
  }
  if (!res.body) {
    const all = Buffer.from(await duringDownload(res.arrayBuffer(), signal));
    if (all.length > cap) throw new AnalysisInputError("compressed_too_large", `The repository archive is larger than the ${cap} byte ceiling.`);
    return all;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await duringDownload(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > cap) throw new AnalysisInputError("compressed_too_large", `The repository archive is larger than the ${cap} byte ceiling.`);
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return Buffer.concat(chunks, total);
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function snapshotFromGithub(req: GithubSnapshotRequest): Promise<RepoSnapshot> {
  const refSegments = validateCoordinates(req.owner, req.repo, req.ref);
  const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...req.limits };
  const doFetch = req.fetchImpl ?? fetch;
  const signal = AbortSignal.any([...(req.signal ? [req.signal] : []), AbortSignal.timeout(req.timeoutMs ?? 60_000)]);

  let url = `https://codeload.github.com/${req.owner}/${req.repo}/tar.gz/${refSegments.map(encodeURIComponent).join("/")}`;
  let res: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (signal.aborted) throw new AnalysisInputError("fetch_failed", "The GitHub download could not be completed.");
    const target = new URL(url);
    const headers: Record<string, string> = { Accept: "application/x-gzip, application/gzip, */*", "User-Agent": "zenith-analysis" };
    if (req.token && target.hostname === "codeload.github.com") headers.Authorization = `Bearer ${req.token}`;
    try {
      const pending = doFetch(url, { method: "GET", headers, redirect: "manual", signal });
      void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => undefined); }, () => undefined);
      res = await duringDownload(pending, signal);
    } catch {
      // Transport diagnostics and abort reasons can contain credentials.
      throw new AnalysisInputError("fetch_failed", "The GitHub download could not be completed.");
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      void res.body?.cancel().catch(() => undefined);
      if (!location || hop === MAX_REDIRECTS) throw new AnalysisInputError("redirect_refused", "GitHub redirected too many times or without a location.");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new AnalysisInputError("redirect_refused", "GitHub redirected to an unreadable location.");
      }
      if (next.protocol !== "https:" || !isGithubHost(next.hostname)) throw new AnalysisInputError("redirect_refused", "GitHub redirected to a host that is not GitHub-owned; not following it.");
      url = next.toString();
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    void res?.body?.cancel().catch(() => undefined);
    const status = res?.status ?? 0;
    throw new AnalysisInputError(
      "fetch_failed",
      status === 404
        ? "GitHub returned 404: the repository or ref does not exist, or it is private and the token cannot read it."
        : `GitHub returned HTTP ${status}.`
    );
  }

  const bytes = await readCapped(res, limits.maxCompressedBytes, signal);
  return snapshotFromTarball(bytes, limits, {
    source: { kind: "github", ref: req.ref, repo: `https://github.com/${req.owner}/${req.repo}` },
    stripComponents: 1,
    includeEvidence: req.includeEvidence,
  });
}
