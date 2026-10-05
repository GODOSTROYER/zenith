/**
 * Static inspection of a monorepo through installation-scoped immutable access. Synthetic
 * tarballs and mocked GitHub HTTP only (no live repository). Proves detection of subdirectory,
 * Dockerfile and buildpack plans, token scoping to one repository, and that no host execution
 * path exists in the inspection or analysis code.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { createGithubSourceInspector, normalizeInspectionRoot } from "@/lib/sources/github/inspect";
import { api, INSTALL_TOKEN, json, keys } from "./fixtures";

const SHA = "a".repeat(40);
function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  const entries: [string, string][] = [["repo-root/", ""], ...Object.entries(files).map(([k, v]): [string, string] => [`repo-root/${k}`, v])];
  for (const [name, text] of entries) {
    const body = Buffer.from(text); const header = Buffer.alloc(512); const dir = name.endsWith("/");
    header.write(name, 0, 100, "utf8"); header.write((dir ? "0000755" : "0000644") + "\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii"); header.write("0000000\0", 116, 8, "ascii");
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii"); header.write("00000000000\0", 136, 12, "ascii");
    header.fill(" ", 148, 156); header.write(dir ? "5" : "0", 156, 1, "ascii"); header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
const MONOREPO = tar({
  "apps/web/Dockerfile": "FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN touch /tmp/never-run-on-host\nEXPOSE 3000\nCMD [\"node\",\"server.js\"]\n",
  "apps/web/package.json": JSON.stringify({ name: "web", scripts: { postinstall: "touch /tmp/host-postinstall-canary", start: "node server.js" }, dependencies: { express: "4.0.0" } }),
  "apps/api/package.json": JSON.stringify({ name: "api", scripts: { start: "node index.js" }, dependencies: { express: "4.0.0" } }),
  "apps/api/index.js": "require('express')().listen(process.env.PORT || 8080);\n",
  "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["apps/*"] }),
});

const entry = (path: string, type: "tree" | "blob", sha: string, mode = type === "tree" ? "040000" : "100644") => ({ path, type, sha, mode });
let TREES: Record<string, unknown> = {
  [SHA]: { truncated: false, tree: [entry("apps", "tree", "1".repeat(40)), entry("link", "blob", "9".repeat(40), "120000")] },
  ["1".repeat(40)]: { truncated: false, tree: [entry("web", "tree", "2".repeat(40)), entry("api", "tree", "3".repeat(40))] },
  ["2".repeat(40)]: { truncated: false, tree: [entry("Dockerfile", "blob", "4".repeat(40))] },
};
let db: PlatformDbHandle; let material: Awaited<ReturnType<typeof keys>>;
beforeAll(async () => { material = await keys(); db = await openPlatformDb({ kind: "pglite", migrate: true }); }, 60_000);
afterAll(async () => { await db?.close(); await material?.close(); });

function github(options: { priv: boolean }) {
  const base = api(); const requests: { url: string; auth?: string; body?: string }[] = [];
  const impl = vi.fn<typeof fetch>(async (url, init) => {
    const value = String(url); const headers = new Headers(init?.headers);
    requests.push({ url: value, auth: headers.get("authorization") ?? undefined, body: typeof init?.body === "string" ? init.body : undefined });
    if (value === "https://api.github.com/repos/acme/app") return json({ id: 99, name: "app", private: options.priv, owner: { login: "acme" } });
    if (value === "https://api.github.com/repos/acme/app/commits/HEAD") return new Response(SHA);
    if (value === `https://codeload.github.com/acme/app/tar.gz/${SHA}`) return new Response(new Uint8Array(MONOREPO));
    const prefix = "https://api.github.com/repos/acme/app/git/trees/";
    if (value.startsWith(prefix)) return json(TREES[value.slice(prefix.length)] ?? { truncated: false, tree: [] });
    return base(url, init);
  });
  return { impl, requests };
}
const appEnv = () => ({ ZENITH_GITHUB_APP_ID: "42", ZENITH_GITHUB_APP_PRIVATE_KEY_FILE: material.config.privateKeyFile });

describe("static GitHub source inspection", () => {
  it("detects monorepo roots, Dockerfile and buildpack plans for a public repository without a binding", async () => {
    const { impl, requests } = github({ priv: false });
    const inspect = createGithubSourceInspector({ db: async () => db, fetchImpl: impl, env: {} });
    const result = await inspect({ workspaceId: "ws-public", owner: "acme", repo: "app", ref: "HEAD" });
    expect(result).toMatchObject({ commitSha: SHA, viaBinding: false, monorepo: true, execution: "static_only" });
    const web = result.candidates.find(c => c.root === "apps/web"); const apiRoot = result.candidates.find(c => c.root === "apps/api");
    expect(web).toMatchObject({ strategy: "dockerfile", dockerfile: "apps/web/Dockerfile" });
    expect(apiRoot?.strategy).toBe("buildpack");
    expect(requests.every(r => r.auth === undefined)).toBe(true);
    const sub = await inspect({ workspaceId: "ws-public", owner: "acme", repo: "app", ref: "HEAD", root: "apps/web" });
    expect(sub.candidates.map(c => c.root)).toEqual(["apps/web"]);
    expect(sub.buildSource).toMatchObject({ repo: "acme/app", ref: SHA, dockerfile: "apps/web/Dockerfile", contextDir: "apps/web" });
    expect(sub.buildSource?.contextDigest).toMatch(/^[a-f0-9]{64}$/);
    const buildpack = await inspect({ workspaceId: "ws-public", owner: "acme", repo: "app", ref: "HEAD", root: "apps/api" });
    expect(buildpack.buildSource).toBeUndefined();
    expect(buildpack.unknowns.join(" ")).toContain("Buildpack builds need a Dockerfile");
  });

  it("reads a private repository only through a per-repository read-only installation token", async () => {
    await db.query(`insert into platform.github_source_bindings (workspace_id, app_id, installation_id, repository_id, owner, repo, version, bound_by)
      values ('ws-private', '42', 7, 99, 'acme', 'app', 1, 'human') on conflict (workspace_id) do nothing`);
    const { impl, requests } = github({ priv: true });
    const inspect = createGithubSourceInspector({ db: async () => db, fetchImpl: impl, env: appEnv() });
    const result = await inspect({ workspaceId: "ws-private", owner: "acme", repo: "app", ref: "HEAD" });
    expect(result.viaBinding).toBe(true);
    const mint = requests.find(r => r.url === "https://api.github.com/app/installations/7/access_tokens");
    expect(JSON.parse(mint!.body!)).toEqual({ repository_ids: [99], permissions: { contents: "read" } });
    expect(requests.filter(r => r.url.startsWith("https://codeload.github.com/")).every(r => r.auth === `Bearer ${INSTALL_TOKEN}`)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(INSTALL_TOKEN);
  });

  it("refuses a private repository without a binding and a revoked binding, fetching no source", async () => {
    const unbound = github({ priv: true });
    await expect(createGithubSourceInspector({ db: async () => db, fetchImpl: unbound.impl, env: {} })({ workspaceId: "ws-none", owner: "acme", repo: "app", ref: "HEAD" })).rejects.toThrow("could not be confirmed");
    expect(unbound.requests.some(r => r.url.includes("codeload"))).toBe(false);
    await db.query("update platform.github_source_bindings set revoked_at = clock_timestamp(), version = 2 where workspace_id = 'ws-private'");
    const revoked = github({ priv: true });
    await expect(createGithubSourceInspector({ db: async () => db, fetchImpl: revoked.impl, env: appEnv() })({ workspaceId: "ws-private", owner: "acme", repo: "app", ref: "HEAD" })).rejects.toThrow("could not be confirmed");
    expect(revoked.requests).toEqual([]);
  });

  it("refuses a context whose Dockerfile component is a symlink at the pinned commit", async () => {
    const saved = TREES;
    TREES = { ...TREES, ["2".repeat(40)]: { truncated: false, tree: [entry("Dockerfile", "blob", "4".repeat(40), "120000")] } };
    try {
      const { impl } = github({ priv: false });
      await expect(createGithubSourceInspector({ db: async () => db, fetchImpl: impl, env: {} })({ workspaceId: "ws-public", owner: "acme", repo: "app", ref: "HEAD", root: "apps/web" })).rejects.toThrow("symbolic link");
    } finally { TREES = saved; }
  });

  it.each(["../x", "/etc", "a//b", "a/./b", "a\\b", "a/..", "x".repeat(201)])("rejects unsafe subdirectory %j", raw => {
    expect(() => normalizeInspectionRoot(raw)).toThrow("invalid");
  });
  it("normalizes safe subdirectories", () => {
    expect(normalizeInspectionRoot(undefined)).toBe(""); expect(normalizeInspectionRoot("apps/web/")).toBe("apps/web");
  });

  it("contains no host-execution primitive in inspection, GitHub source or analysis code", () => {
    const roots = ["src/lib/sources/github", "src/lib/analysis", "src/app/api/platform/v1/github"];
    const banned = /child_process|node:vm|\bspawn\(|\bexecSync\b|\bexecFile\b|\beval\(|new Function\(|worker_threads|writeFile|mkdtemp/;
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
    for (const root of roots) for (const file of walk(path.resolve(root))) {
      if (file.endsWith("migrate.ts")) continue;
      expect(readFileSync(file, "utf8"), file).not.toMatch(banned);
    }
  });
});
