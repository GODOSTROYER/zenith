import { createHash, X509Certificate } from "node:crypto";
import { chmod, copyFile, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseManifest, verifyProvenance, type TrustedPublishers } from "@/lib/plugins/manifest";
import { apiUrl, assertLease, httpAuthority, LauncherError, tokenDigest, type LauncherAuthority } from "./authority";
import type { ContainerRuntime, SandboxSpec } from "./runtime";

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export interface LaunchInput {
  manifest: unknown;
  reviewedDigest: string;
  registrationId: string;
  workspaceId: string;
  apiOrigin: string;
  token: string;
  image: string;
  server: string;
  caFile?: string;
}
export interface LaunchDeps {
  publishers: TrustedPublishers;
  runtime: ContainerRuntime;
  authority?: LauncherAuthority;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  sandboxDirectory?: string;
  pollMs?: number;
}

async function fetchArtifact(url: string, digest: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<Buffer> {
  const source = new URL(url);
  if (source.protocol !== "https:" || source.username || source.password || source.hash) throw new LauncherError("invalid_artifact_url");
  try {
    const response = await fetcher(source, { redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]), credentials: "omit" });
    if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > MAX_ARTIFACT_BYTES) throw new Error();
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_ARTIFACT_BYTES) throw new Error();
        parts.push(next.value);
      }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(parts);
    if (createHash("sha256").update(bytes).digest("hex") !== digest) throw new LauncherError("artifact_digest_mismatch");
    return bytes;
  } catch (error) {
    if (error instanceof LauncherError) throw error;
    throw new LauncherError("artifact_fetch_refused");
  }
}

async function publicCa(file: string): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65_536) throw new Error();
    const buffer = Buffer.alloc(65_537); let size = 0;
    while (size < buffer.length) {
      const part = await handle.read(buffer, size, buffer.length - size, null);
      if (!part.bytesRead) break; size += part.bytesRead;
    }
    if (size > 65_536) throw new Error();
    const text = buffer.subarray(0, size).toString("utf8");
    const certificates = text.match(/-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g);
    if (!certificates?.length || text.replace(/-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g, "").trim()) throw new Error();
    for (const pem of certificates) new X509Certificate(pem);
    return buffer.subarray(0, size);
  } catch { throw new LauncherError("public_ca_required"); }
  finally { await handle.close(); }
}

/** Reachable from plugins/bin.ts. No shell, host extraction, inherited env,
 * token minting, privileged container mode or unverified execution path. */
export async function launchPlugin(input: LaunchInput, deps: LaunchDeps): Promise<{ exitCode: number }> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new LauncherError("tls_verification_required");
  const parsed = parseManifest(input.manifest);
  verifyProvenance(parsed, deps.publishers);
  if (!/^[a-f0-9]{64}$/.test(input.reviewedDigest) || input.reviewedDigest !== parsed.manifestDigest) throw new LauncherError("review_digest_mismatch");
  if (!/^za_[A-Za-z0-9_-]{43}$/.test(input.token)) throw new LauncherError("scoped_za_required");
  if (!/^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(input.image)) throw new LauncherError("sandbox_image_digest_required");
  if (parsed.manifest.artifact.format !== "tar.gz" && parsed.manifest.artifact.format !== "tgz") throw new LauncherError("unsupported_artifact_format");
  if (!parsed.manifest.artifact.url) throw new LauncherError("artifact_url_required");
  const server = parsed.manifest.components?.mcpServers?.find((s) => s.name === input.server);
  if (!server || server.command !== "node" || !/^\$\{CLAUDE_PLUGIN_ROOT\}\/[A-Za-z0-9_./-]+\.m?js$/.test(server.args[0] ?? "") ||
      server.args[0].split("/").some((p) => p === ".." || p === ".") ||
      Object.keys(server.env ?? {}).some((key) => !["ZENITH_API_VERSION"].includes(key)) ||
      (server.env?.ZENITH_API_VERSION !== undefined && server.env.ZENITH_API_VERSION !== "3")) throw new LauncherError("unsupported_plugin_entrypoint");
  const origin = apiUrl(input.apiOrigin);
  const binding = { registrationId: input.registrationId, workspaceId: input.workspaceId, manifestDigest: parsed.manifestDigest, credentialDigest: tokenDigest(input.token), audience: new URL("/api/agent/v3/mcp", origin).href };
  const authority = deps.authority ?? httpAuthority(origin, deps.fetch);
  const lease = assertLease(await authority.check(binding, input.token, deps.signal), binding, parsed.manifest);
  const bytes = await fetchArtifact(parsed.manifest.artifact.url, parsed.artifactDigest, deps.fetch ?? fetch, deps.signal);
  // Recheck after download before creating any executable container.
  assertLease(await authority.check(binding, input.token, deps.signal), binding, parsed.manifest, lease);
  if (deps.signal?.aborted) throw new LauncherError("launch_cancelled");
  const pollMs = deps.pollMs ?? 1000;
  if (!Number.isInteger(pollMs) || pollMs < 10 || pollMs > 1000) throw new LauncherError("invalid_revocation_interval");
  const ca = input.caFile ? await publicCa(input.caFile) : undefined;
  const scratch = await mkdtemp(join(tmpdir(), "zenith-plugin-"));
  let sandbox: Awaited<ReturnType<ContainerRuntime["start"]>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const interrupt = () => wake?.();
  deps.signal?.addEventListener("abort", interrupt);
  try {
    await writeFile(join(scratch, "artifact.tgz"), bytes, { mode: 0o444 });
    const directory = deps.sandboxDirectory ?? resolve("deploy/plugin-sandbox");
    for (const name of ["gateway.mjs", "runner.mjs", "transport.mjs"]) await copyFile(join(directory, name), join(scratch, name));
    if (ca) await writeFile(join(scratch, "ca.pem"), ca, { mode: 0o444 });
    // Public, verified payloads only. Container uid 65532 needs traversal;
    // the bearer is never written into this host directory.
    await chmod(scratch, 0o755);
    const spec: SandboxSpec = {
      image: input.image, scratch,
      bootstrap: { token: input.token, binding, lease, apiOrigin: origin.origin, artifactDigest: parsed.artifactDigest, args: server.args, env: server.env ?? {} },
      ca: Boolean(input.caFile),
    };
    sandbox = await deps.runtime.start(spec);
    const settled = sandbox.wait().then((exitCode) => ({ exitCode }));
    // Suppress unhandled rejection while checking authority; it is still
    // propagated when the race observes gateway/runtime failure.
    void settled.catch(() => {});
    for (;;) {
      if (deps.signal?.aborted) throw new LauncherError("launch_cancelled");
      assertLease(await authority.check(binding, input.token, deps.signal), binding, parsed.manifest, lease);
      const result = await Promise.race([
        settled,
        new Promise<undefined>((done) => { wake = () => done(undefined); timer = setTimeout(wake, pollMs); }),
      ]);
      if (timer) clearTimeout(timer);
      wake = undefined;
      if (result) return result;
    }
  } finally {
    if (timer) clearTimeout(timer);
    deps.signal?.removeEventListener("abort", interrupt);
    // Removal is part of success. A failed kill/removal surfaces a failure,
    // preserving scratch for diagnosis instead of declaring false cleanup.
    if (sandbox) await sandbox.stop();
    await rm(scratch, { recursive: true, force: true });
  }
}
