import { describe, expect, it, vi } from "vitest";
import zlib from "node:zlib";
import { AnalysisInputError, DEFAULT_SNAPSHOT_LIMITS, checkEntryPath, classifyPath, snapshotFromFiles, snapshotFromGithub, snapshotFromTarball } from "@/lib/analysis";
import { gzip, paxRecord, writeTar, type TarEntry } from "../_support/tar";

const text = (s: string): Buffer => Buffer.from(s, "utf8");
const file = (path: string, content: string): TarEntry => ({ path, bytes: text(content) });
const paths = (s: { files: { path: string }[] }): string[] => s.files.map((f) => f.path);
const skipped = (s: { skipped?: { reason: string; count: number }[] }, reason: string): number => s.skipped?.find((x) => x.reason === reason)?.count ?? 0;
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("checkEntryPath", () => {
  const ok = (p: string) => checkEntryPath(p);
  it("normalises harmless paths", () => {
    expect(ok("a/b/c.js")).toEqual({ ok: true, path: "a/b/c.js" });
    expect(ok("./a//b/./c.js")).toEqual({ ok: true, path: "a/b/c.js" });
    expect(ok("src/app/[id]/page.tsx")).toEqual({ ok: true, path: "src/app/[id]/page.tsx" });
    expect(ok("routes/posts.$id.tsx")).toEqual({ ok: true, path: "routes/posts.$id.tsx" });
  });

  it("refuses traversal, absolute paths and anything that could name a file elsewhere", () => {
    expect(ok("../evil.js")).toEqual({ ok: false, reason: "traversal" });
    expect(ok("a/../../evil.js")).toEqual({ ok: false, reason: "traversal" });
    expect(ok("a/..")).toEqual({ ok: false, reason: "traversal" });
    expect(ok("/etc/passwd")).toEqual({ ok: false, reason: "absolute_path" });
    expect(ok("C:/Windows/x")).toEqual({ ok: false, reason: "absolute_path" });
    expect(ok("a\\b.js")).toEqual({ ok: false, reason: "bad_path" });
    expect(ok("a\nb.js")).toEqual({ ok: false, reason: "bad_path" });
    expect(ok("a\u0000b.js")).toEqual({ ok: false, reason: "bad_path" });
    expect(ok("")).toEqual({ ok: false, reason: "bad_path" });
    expect(ok("./")).toEqual({ ok: false, reason: "bad_path" });
  });

  it("refuses shell and markup metacharacters, because paths end up in evidence and manifests", () => {
    for (const bad of ["a;rm -rf.js", "a|b.js", "a&b.js", "`x`.js", "a'b.js", 'a"b.js', "a<b>.js", "a*.js", "a?.js", "a{b}.js", "a!b.js"]) {
      expect(ok(bad), bad).toMatchObject({ ok: false, reason: "bad_path" });
    }
  });

  it("enforces length and depth limits", () => {
    expect(checkEntryPath("x".repeat(300))).toEqual({ ok: false, reason: "path_too_long" });
    expect(checkEntryPath(`${"d/".repeat(30)}x.js`)).toEqual({ ok: false, reason: "too_deep" });
    expect(checkEntryPath("a/b.js", { ...DEFAULT_SNAPSHOT_LIMITS, maxDepth: 1 })).toEqual({ ok: false, reason: "too_deep" });
  });
});

describe("classifyPath", () => {
  it("keeps manifests, build files, config and source; drops everything else", () => {
    expect(classifyPath("package.json")).toBe("config");
    expect(classifyPath("apps/api/Dockerfile")).toBe("config");
    expect(classifyPath("apps/api/api.Dockerfile")).toBe("config");
    expect(classifyPath("docker-compose.override.yml")).toBe("config");
    expect(classifyPath("requirements/base.txt")).toBe("config");
    expect(classifyPath("k8s/deploy.yaml")).toBe("config");
    expect(classifyPath("main.tf")).toBe("config");
    expect(classifyPath("src/server.ts")).toBe("source");
    expect(classifyPath("app/models/user.rb")).toBe("source");
    expect(classifyPath(".env.production")).toBe("env");
    expect(classifyPath("package-lock.json")).toBe("marker");
    expect(classifyPath("db/migrations/001.sql")).toBe("marker");
    for (const p of ["README.md", "logo.png", "data.csv", "notes.txt", "src/style.css", "schema.sql", "id_rsa", "server.pem", "terraform.tfstate", "prod.tfvars"]) expect(classifyPath(p), p).toBeUndefined();
  });

  it("ignores vendored, generated, test and docs directories", () => {
    for (const p of ["node_modules/x/index.js", "vendor/lib/a.go", "dist/app.js", "tests/a.test.ts", "src/__tests__/a.ts", "docs/example/package.json", "test/fixtures/Dockerfile", ".git/config", ".venv/lib/x.py"]) {
      expect(classifyPath(p), p).toBeUndefined();
    }
  });
});

describe("snapshotFromTarball: what is kept and what is refused", () => {
  it("reads a GitHub-style archive: strips the wrapper directory, keeps the commit from the pax header", () => {
    const tar = writeTar([
      { path: "pax_global_header", type: "paxGlobal", bytes: paxRecord("comment", SHA) },
      { path: `acme-app-${SHA.slice(0, 7)}/`, type: "dir" },
      file(`acme-app-${SHA.slice(0, 7)}/package.json`, '{"name":"x"}'),
      file(`acme-app-${SHA.slice(0, 7)}/src/index.js`, "console.log(1)"),
      file(`acme-app-${SHA.slice(0, 7)}/README.md`, "# hi"),
    ]);
    const snap = snapshotFromTarball(gzip(tar), {}, { source: { kind: "github", ref: "main", repo: "https://github.com/acme/app" } });
    expect(paths(snap)).toEqual(["package.json", "src/index.js"]);
    expect(snap.source).toEqual({ kind: "github", ref: "main", repo: "https://github.com/acme/app", commit: SHA });
    expect(snap.truncated).toBe(false);
    expect(skipped(snap, "irrelevant")).toBe(1);
  });

  it("accepts a plain (not gzipped) tar and defaults the source to a tarball", () => {
    const snap = snapshotFromTarball(writeTar([file("package.json", "{}")]));
    expect(paths(snap)).toEqual(["package.json"]);
    expect(snap.source).toEqual({ kind: "tarball" });
  });

  it("strips a single wrapper directory but not a conventional source directory", () => {
    expect(paths(snapshotFromTarball(writeTar([file("wrapper/package.json", "{}"), file("wrapper/src/a.js", "1")])))).toEqual(["package.json", "src/a.js"]);
    expect(paths(snapshotFromTarball(writeTar([file("src/a.js", "1"), file("src/b.js", "2")])))).toEqual(["src/a.js", "src/b.js"]);
    expect(paths(snapshotFromTarball(writeTar([file("package.json", "{}"), file("wrapper/x.js", "1")])))).toEqual(["package.json", "wrapper/x.js"]);
    expect(paths(snapshotFromTarball(writeTar([file("a/b/package.json", "{}")]), {}, { stripComponents: 2 }))).toEqual(["package.json"]);
  });

  it("refuses traversal, absolute and unsafe names and reports them without keeping them", () => {
    const snap = snapshotFromTarball(
      writeTar([
        file("../evil.js", "x"),
        file("a/../../evil2.js", "x"),
        file("/etc/cron.d/x.js", "x"),
        file("bad;name.js", "x"),
        file("back\\slash.js", "x"),
        file("ok.js", "ok"),
      ])
    );
    expect(paths(snap)).toEqual(["ok.js"]);
    expect(skipped(snap, "traversal")).toBe(2);
    expect(skipped(snap, "absolute_path")).toBe(1);
    expect(skipped(snap, "bad_path")).toBe(2);
  });

  it("skips symlinks, hard links and device entries instead of following them", () => {
    const snap = snapshotFromTarball(
      writeTar([
        { path: "link.js", type: "symlink", linkname: "/etc/passwd" },
        { path: "hard.js", type: "hardlink", linkname: "ok.js" },
        { path: "dev.js", type: "chardev" },
        { path: "pipe.js", type: "fifo" },
        file("ok.js", "ok"),
      ])
    );
    expect(paths(snap)).toEqual(["ok.js"]);
    expect(skipped(snap, "symlink")).toBe(1);
    expect(skipped(snap, "hardlink")).toBe(1);
    expect(skipped(snap, "special_entry")).toBe(2);
    expect(snap.truncated).toBe(false);
  });

  it("skips oversize and binary files, and never copies their bytes", () => {
    const snap = snapshotFromTarball(
      writeTar([file("src/huge.js", "a".repeat(10 * 1024 * 1024)), { path: "src/blob.js", bytes: Buffer.from([0x61, 0x00, 0x62]) }, file("src/ok.js", "1")])
    );
    expect(paths(snap)).toEqual(["src/ok.js"]);
    expect(skipped(snap, "oversize")).toBe(1);
    expect(skipped(snap, "binary")).toBe(1);
    expect(snap.skipped?.find((s) => s.reason === "oversize")?.examples).toEqual(["src/huge.js"]);
  });

  it("keeps the first of a duplicated path", () => {
    const snap = snapshotFromTarball(writeTar([file("package.json", '{"first":1}'), file("package.json", '{"second":1}')]));
    expect(snap.files).toEqual([{ path: "package.json", content: '{"first":1}' }]);
    expect(skipped(snap, "duplicate")).toBe(1);
  });

  it("rewrites .env files to names only before they are kept", () => {
    const snap = snapshotFromTarball(writeTar([file(".env", "API_SECRET=sk_live_CANARY123456789012345\nEMPTY=\n# comment with a=secret\nexport DB_URL='postgres://u:pw@h/db'\n"), file(".env.example", "FOO=bar\n")]));
    const env = snap.files.find((f) => f.path === ".env")!.content;
    expect(env).not.toContain("CANARY");
    expect(env).not.toContain("postgres://");
    expect(env).not.toContain("comment");
    expect(env.split("\n")).toEqual(["API_SECRET=<set:secret-like>", "EMPTY=", "", "DB_URL=<set:secret-like>", ""]);
    expect(snap.files.find((f) => f.path === ".env.example")!.content).toBe("FOO=<set>\n");
  });

  it("keeps lock files and migration SQL as content-free markers, whatever their size", () => {
    const snap = snapshotFromTarball(writeTar([file("package-lock.json", "x".repeat(3 * 1024 * 1024)), file("db/migrations/001.sql", "DROP TABLE users;")]));
    expect(snap.files).toEqual([
      { path: "db/migrations/001.sql", content: "" },
      { path: "package-lock.json", content: "" },
    ]);
  });

  it("does not depend on archive order", () => {
    const entries = [file("package.json", "{}"), file("src/a.js", "1"), file("Dockerfile", "FROM node"), file("README.md", "x")];
    expect(snapshotFromTarball(writeTar(entries))).toEqual(snapshotFromTarball(writeTar([...entries].reverse())));
  });

  it("honours pax path records and GNU long names for long paths", () => {
    const long = `${"deeply/".repeat(20)}nested/package.json`;
    const pax = writeTar([{ path: "PaxHeaders", type: "pax", bytes: paxRecord("path", long) }, file("short-name", "{}")]);
    expect(paths(snapshotFromTarball(pax, {}, { stripComponents: 0 }))).toEqual([long]);
    const gnu = writeTar([{ path: "././@LongLink", type: "gnuLongName", bytes: Buffer.from(`${long}\u0000`) }, file("short-name", "{}")]);
    expect(paths(snapshotFromTarball(gnu, {}, { stripComponents: 0 }))).toEqual([long]);
  });
});

describe("snapshotFromTarball: bounds", () => {
  it("rejects an empty upload and an archive over the compressed limit before reading it", () => {
    expect(() => snapshotFromTarball(Buffer.alloc(0))).toThrowError(expect.objectContaining({ name: "AnalysisInputError", code: "empty_archive" }));
    const big = gzip(writeTar([file("package.json", "{}")]));
    expect(() => snapshotFromTarball(big, { maxCompressedBytes: big.length - 1 })).toThrowError(expect.objectContaining({ code: "compressed_too_large" }));
    expect(() => snapshotFromTarball(big, { maxCompressedBytes: big.length })).not.toThrow();
  });

  it("stops a decompression bomb at the uncompressed ceiling", () => {
    const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024, 0));
    expect(bomb.length).toBeLessThan(200 * 1024); // the point of a bomb
    expect(() => snapshotFromTarball(bomb, { maxUncompressedBytes: 1024 * 1024 })).toThrowError(expect.objectContaining({ code: "uncompressed_too_large" }));
    const rawBig = writeTar([file("package.json", "{}")]);
    expect(() => snapshotFromTarball(rawBig, { maxUncompressedBytes: 100 })).toThrowError(expect.objectContaining({ code: "uncompressed_too_large" }));
  });

  it("rejects a gzip magic number with garbage behind it", () => {
    const garbage = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(64, 7)]);
    expect(() => snapshotFromTarball(garbage)).toThrowError(expect.objectContaining({ code: "not_gzip" }));
  });

  it("caps the number of entries examined and marks the snapshot truncated", () => {
    const entries = Array.from({ length: 50 }, (_, i) => file(`src/f${String(i).padStart(2, "0")}.js`, "1"));
    const snap = snapshotFromTarball(writeTar(entries), { maxEntries: 10 });
    expect(snap.files).toHaveLength(10);
    expect(snap.truncated).toBe(true);
    expect(skipped(snap, "limit_entries")).toBe(1);
  });

  it("caps kept files and kept bytes and marks the snapshot truncated", () => {
    const entries = Array.from({ length: 20 }, (_, i) => file(`src/f${String(i).padStart(2, "0")}.js`, "x".repeat(100)));
    const byCount = snapshotFromTarball(writeTar(entries), { maxKeptFiles: 5 });
    expect(byCount.files).toHaveLength(5);
    expect(byCount.truncated).toBe(true);
    expect(skipped(byCount, "limit_kept_files")).toBe(15);
    const byBytes = snapshotFromTarball(writeTar(entries), { maxKeptBytes: 450 });
    expect(byBytes.files).toHaveLength(4);
    expect(byBytes.truncated).toBe(true);
  });

  it("stops at a corrupt header and reports the read as partial, keeping what came before", () => {
    const tar = writeTar([file("package.json", "{}"), { path: "src/bad.js", bytes: text("1"), corruptChecksum: true }, file("src/after.js", "1")]);
    const snap = snapshotFromTarball(tar);
    expect(paths(snap)).toEqual(["package.json"]);
    expect(snap.truncated).toBe(true);
  });

  it("treats a truncated archive as partial, not as an error", () => {
    const tar = writeTar([file("package.json", "{}"), file("src/big.js", "y".repeat(4000))], { terminate: false });
    const cut = tar.subarray(0, tar.length - 2500);
    const snap = snapshotFromTarball(cut);
    expect(paths(snap)).toEqual(["package.json"]);
    expect(snap.truncated).toBe(true);
  });

  it("limits path length and depth per entry, not for the whole archive", () => {
    const snap = snapshotFromTarball(writeTar([file(`${"d/".repeat(30)}x.js`, "1"), { path: "b.js", prefix: "p".repeat(150), bytes: text("1") }, file("ok.js", "1")]), { maxPathLength: 100 });
    expect(paths(snap)).toEqual(["ok.js"]);
    expect(skipped(snap, "too_deep") + skipped(snap, "path_too_long")).toBe(2);
  });
});

describe("snapshotFromFiles", () => {
  it("applies the same rules as a tarball", () => {
    const snap = snapshotFromFiles({ "package.json": "{}", "../x.js": "1", "README.md": "x", ".env": "A=secretvalue\n", "src/big.js": "a".repeat(2 * 1024 * 1024) });
    expect(paths(snap)).toEqual([".env", "package.json"]);
    expect(snap.files[0].content).toBe("A=<set>\n");
    expect(skipped(snap, "traversal")).toBe(1);
    expect(skipped(snap, "oversize")).toBe(1);
    expect(snap.source).toEqual({ kind: "fixture" });
  });
});

/* ------------------------------------------------------------------------- */

const TOKEN = "ghp_CANARYtoken0123456789abcdefghijklmnop";
const archive = gzip(writeTar([{ path: "pax_global_header", type: "paxGlobal", bytes: paxRecord("comment", SHA) }, file("app-abc/package.json", '{"name":"x"}'), file("app-abc/main.go", "package main\nfunc main() {}\n")]));

const okResponse = (body: Buffer = archive, headers: Record<string, string> = {}) => new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length), ...headers } });

describe("snapshotFromGithub", () => {
  it("downloads the codeload tarball, sends the token only as a header, and never stores it", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const snap = await snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", token: TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://codeload.github.com/acme/app/tar.gz/main");
    expect(url).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.redirect).toBe("manual");
    expect(paths(snap)).toEqual(["main.go", "package.json"]);
    expect(snap.source).toEqual({ kind: "github", ref: "main", repo: "https://github.com/acme/app", commit: SHA });
    expect(JSON.stringify(snap)).not.toContain(TOKEN);
  });

  it("sends no Authorization header without a token, and keeps slashes in branch names", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await snapshotFromGithub({ owner: "acme", repo: "app.js", ref: "feature/x-1", fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://codeload.github.com/acme/app.js/tar.gz/feature/x-1");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("refuses coordinates that could change the URL, before any request", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const f = fetchImpl as unknown as typeof fetch;
    const bad: { owner: string; repo: string; ref: string }[] = [
      { owner: "a/b", repo: "app", ref: "main" },
      { owner: "-x", repo: "app", ref: "main" },
      { owner: "acme", repo: "..", ref: "main" },
      { owner: "acme", repo: "a b", ref: "main" },
      { owner: "acme", repo: "app", ref: "../x" },
      { owner: "acme", repo: "app", ref: "a b" },
      { owner: "acme", repo: "app", ref: "" },
      { owner: "acme", repo: "app", ref: "main?x=1" },
      { owner: "acme", repo: "app", ref: "main#frag" },
      { owner: "acme", repo: "app", ref: "a//b" },
    ];
    for (const c of bad) await expect(snapshotFromGithub({ ...c, fetchImpl: f }), JSON.stringify(c)).rejects.toMatchObject({ code: "invalid_coordinates" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports HTTP errors without leaking the token", async () => {
    const f404 = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const err = await snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", token: TOKEN, fetchImpl: f404 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalysisInputError);
    expect((err as AnalysisInputError).code).toBe("fetch_failed");
    expect((err as Error).message).toContain("404");
    expect((err as Error).message).not.toContain(TOKEN);
    const f500 = vi.fn(async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    await expect(snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", fetchImpl: f500 })).rejects.toMatchObject({ code: "fetch_failed" });
  });

  it("does not echo an underlying network error, which could contain a header", async () => {
    const boom = vi.fn(async () => {
      throw new TypeError(`connect failed Authorization: Bearer ${TOKEN}`);
    }) as unknown as typeof fetch;
    const err = (await snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", token: TOKEN, fetchImpl: boom }).catch((e: unknown) => e)) as AnalysisInputError;
    expect(err.message).not.toContain(TOKEN);
    expect(err.code).toBe("fetch_failed");
  });

  it("follows redirects only to GitHub-owned hosts and never forwards the token off codeload", async () => {
    const calls: { url: string; auth?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      if (url.startsWith("https://codeload.github.com")) return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/blob/1" } });
      return okResponse();
    }) as unknown as typeof fetch;
    const snap = await snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", token: TOKEN, fetchImpl });
    expect(paths(snap)).toEqual(["main.go", "package.json"]);
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["codeload.github.com", "objects.githubusercontent.com"]);
    expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(calls[1].auth).toBeUndefined();
  });

  it("refuses redirects to other hosts, to plain http, and redirect loops", async () => {
    const to = (location: string) => vi.fn(async () => new Response(null, { status: 302, headers: { location } })) as unknown as typeof fetch;
    for (const location of ["https://evil.example/x", "http://codeload.github.com/x", "https://github.com.evil.example/x", "https://evilgithubusercontent.com/x"]) {
      await expect(snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", token: TOKEN, fetchImpl: to(location) }), location).rejects.toMatchObject({ code: "redirect_refused" });
    }
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://codeload.github.com/acme/app/tar.gz/main" } }));
    await expect(snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", fetchImpl: loop as unknown as typeof fetch })).rejects.toMatchObject({ code: "redirect_refused" });
    expect(loop).toHaveBeenCalledTimes(4); // the first request plus three redirects, then it stops
  });

  it("stops at the compressed-size cap: by Content-Length, and by counting a streamed body", async () => {
    const declared = vi.fn(async () => okResponse(archive, { "content-length": String(archive.length * 1000) })) as unknown as typeof fetch;
    await expect(snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", fetchImpl: declared, limits: { maxCompressedBytes: archive.length * 10 } })).rejects.toMatchObject({ code: "compressed_too_large" });

    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
        if (pulled > 10_000) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const streamed = vi.fn(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    await expect(snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", fetchImpl: streamed, limits: { maxCompressedBytes: 8 * 1024 } })).rejects.toMatchObject({ code: "compressed_too_large" });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(50); // it did not read the endless body
  });

  it("applies the tarball bounds to what it downloaded", async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0));
    const f = vi.fn(async () => okResponse(bomb)) as unknown as typeof fetch;
    await expect(snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", fetchImpl: f, limits: { maxUncompressedBytes: 1024 * 1024 } })).rejects.toMatchObject({ code: "uncompressed_too_large" });
  });
});
