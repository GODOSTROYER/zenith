import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createSourceBundles } from "@/lib/platform/source-bundle";
import { fixtureResponse, sourceArchive } from "../../../scripts/release/drivers/github-emulator.mjs";
import { githubFixture } from "../../../scripts/release/drivers/github-fixture";

function tarFiles(archive: Uint8Array): Array<{ path: string; bytes: Buffer }> {
  const raw = gunzipSync(archive), files: Array<{ path: string; bytes: Buffer }> = [];
  for (let offset = 0; offset + 512 <= raw.length;) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const path = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > raw.length) throw new Error("invalid fixture tar entry");
    files.push({ path, bytes: Buffer.from(raw.subarray(offset + 512, offset + 512 + size)) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const dockerfile = "FROM scratch\nCOPY app.c /src/app.c\n";
const sourceFixture = { appC: "#include <stdio.h>\nint main(void) { return 0; }\n", migrationSql: "CREATE TABLE fixture(id integer);\n" };

describe("bounded three-file DRV-1 source fixture archive", () => {
  it("delivers exactly the three fixed source files on the prefixed wire and preserves bytes after canonicalization", async () => {
    const config = { appId: "815", installationId: 816, repositoryId: 817, repository: "zenith-local/private-source",
      installationToken: "token", userToken: "user", commit: "a".repeat(40), movedCommit: "b".repeat(40), dockerfile,
      sourceFixture };
    const wire = fixtureResponse(config, { refused: 0, archiveReads: 0, movedArchiveReads: 0, moved: false, revoked: false }, {
      host: "codeload.github.com", url: "/zenith-local/private-source/tar.gz/" + config.commit,
      method: "GET", authorization: "Bearer token",
    });
    expect(wire.status).toBe(200);
    const wireFiles = tarFiles(wire.body);
    expect(wireFiles.map(file => file.path)).toEqual(["fixture-/Dockerfile", "fixture-/app.c", "fixture-/migration.sql"]);
    expect(wireFiles.map(file => file.bytes.toString("utf8"))).toEqual([dockerfile, sourceFixture.appC, sourceFixture.migrationSql]);

    const bundles = createSourceBundles({ fetchImpl: async () => new Response(Buffer.from(wire.body)), withGithubAccess: async (_scope, fn) => fn() });
    const bundle = await bundles.read({ repo: "zenith-local/private-source", ref: config.commit, dockerfile: "Dockerfile" });
    const canonical = sourceArchive(dockerfile, "", undefined, sourceFixture);
    expect(Buffer.from(bundle.archive)).toEqual(canonical);
    const strippedFiles = tarFiles(bundle.archive);
    expect(strippedFiles.map(file => file.path)).toEqual(["Dockerfile", "app.c", "migration.sql"]);
    expect(strippedFiles.map(file => file.bytes.toString("utf8"))).toEqual([dockerfile, sourceFixture.appC, sourceFixture.migrationSql]);
  });

  it("refuses explicitly supplied null or malformed caller fixtures before engine access", async () => {
    await expect(githubFixture({} as never, { profile: {} as never, dockerfile, sourceFixture: null } as never))
      .rejects.toThrow("source-fixture-archive-shape");
    await expect(githubFixture({} as never, { profile: {} as never, dockerfile, sourceFixture: { appC: "ok", migrationSql: "ok", path: "../../outside" } } as never))
      .rejects.toThrow("source-fixture-archive-shape");
  });

  it("rejects oversized source text before allocating archive buffers", () => {
    const from = vi.spyOn(Buffer, "from");
    const alloc = vi.spyOn(Buffer, "alloc");
    try {
      expect(() => sourceArchive(dockerfile, "", undefined, { appC: "x".repeat(64 * 1024 + 1), migrationSql: "y" })).toThrow();
      expect(from).not.toHaveBeenCalled();
      expect(alloc).not.toHaveBeenCalled();
    } finally {
      from.mockRestore();
      alloc.mockRestore();
    }
  });

  it("is deterministic and accepts only the bounded exact fixture shape", () => {
    expect(sourceArchive(dockerfile, "", undefined, sourceFixture)).toEqual(sourceArchive(dockerfile, "", undefined, sourceFixture));
    expect(() => sourceArchive(dockerfile, "", undefined, { ...sourceFixture, path: "../../outside" } as typeof sourceFixture)).toThrow();
    expect(() => sourceArchive(dockerfile, "", undefined, null as unknown as typeof sourceFixture)).toThrow();
    expect(() => sourceArchive(dockerfile, "", undefined, { appC: 7, migrationSql: "y" } as unknown as typeof sourceFixture)).toThrow();
    expect(() => sourceArchive(dockerfile, "", undefined, { appC: "x".repeat(64 * 1024 + 1), migrationSql: "y" })).toThrow();
    expect(() => sourceArchive("x", "", undefined, { appC: "x".repeat(64 * 1024 - 1), migrationSql: "y".repeat(64 * 1024) })).not.toThrow();
    expect(() => sourceArchive(dockerfile, "", undefined, { appC: "é".repeat(32 * 1024 + 1), migrationSql: "y" })).toThrow();
    expect(() => sourceArchive(dockerfile, "", undefined, { appC: "", migrationSql: "y" })).toThrow();
    expect(() => sourceArchive(dockerfile, "", undefined, { appC: "x\0y", migrationSql: "y" })).toThrow();
    expect(() => sourceArchive(dockerfile, "fixtures/", undefined, sourceFixture)).toThrow();
    expect(() => sourceArchive(dockerfile, "", "ZXh0cmEtZXhlY3V0YWJsZQ==", sourceFixture)).toThrow();
  });
});
