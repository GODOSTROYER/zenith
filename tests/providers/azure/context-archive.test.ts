/** Non-root ACR build context (PROD-LIFE-04): the uploaded archive is built only from the validated contextDir. */
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { contextArchive, OUTSIDE_DOCKERFILE } from "@/lib/providers/azure/release/context-archive";
import { tarGz } from "../../../scripts/acceptance/azure-live";
import { contextDirOf } from "@/lib/execution/build-isolation";

const repo = () => tarGz({
  Dockerfile: "FROM root\n",
  "README.md": "root readme",
  "apps/web/Dockerfile": "FROM web\n",
  "apps/web/src/index.js": "console.log(1)",
  "apps/api/Dockerfile": "FROM api\n",
  "secrets/.env": "NOT-IN-CONTEXT",
});
const names = (a: Uint8Array) => {
  const tar = gunzipSync(a); const out: string[] = [];
  for (let o = 0; o + 512 <= tar.length && !tar.subarray(o, o + 512).every((x) => x === 0);) {
    const h = tar.subarray(o, o + 512); const z = h.indexOf(0);
    out.push(h.subarray(0, Math.min(z < 0 ? 100 : z, 100)).toString("utf8"));
    o += 512 + Math.ceil(parseInt(h.subarray(124, 135).toString("utf8"), 8) / 512) * 512;
  }
  return out;
};

describe("contextArchive", () => {
  it("is the identity for the repository root", () => {
    const a = repo();
    expect(contextArchive(a, ".", "Dockerfile")).toEqual({ archive: a, dockerfilePath: "Dockerfile" });
  });
  it("contains only the context directory and strips its prefix when the Dockerfile is inside it", () => {
    const r = contextArchive(repo(), "apps/web", "apps/web/Dockerfile");
    expect(r.dockerfilePath).toBe("Dockerfile");
    expect(names(r.archive).sort()).toEqual(["Dockerfile", "src/index.js"]);
  });
  it("carries a repository-root Dockerfile at the reserved path and nothing else from outside", () => {
    const r = contextArchive(repo(), "apps/web");
    expect(r.dockerfilePath).toBe(OUTSIDE_DOCKERFILE);
    const n = names(r.archive);
    expect(n).toEqual(expect.arrayContaining(["Dockerfile", "src/index.js", ".zenith/Dockerfile"]));
    expect(n.some((x) => x.includes("secrets") || x.includes("api") || x === "README.md")).toBe(false);
    expect(gunzipSync(r.archive).includes("NOT-IN-CONTEXT")).toBe(false);
  });
  it("is deterministic", () => {
    expect(Buffer.from(contextArchive(repo(), "apps/web").archive).equals(Buffer.from(contextArchive(repo(), "apps/web").archive))).toBe(true);
  });
  it("fails closed on a missing directory, a missing Dockerfile, a reserved-path clash and bad input", () => {
    expect(() => contextArchive(repo(), "apps/none")).toThrow(/no files/);
    expect(() => contextArchive(repo(), "apps/web", "missing/Dockerfile")).toThrow(/not found/);
    expect(() => contextArchive(tarGz({ "Dockerfile": "x", "d/.zenith/a": "y", "d/f": "z" }), "d")).toThrow(/reserved/);
    expect(() => contextArchive(repo(), "../x")).toThrow(/normalized/);
    expect(() => contextArchive(repo(), "a//b")).toThrow(/normalized/);
    expect(() => contextArchive(new Uint8Array([1, 2, 3]), "apps/web")).toThrow(/unreadable/);
    expect(() => contextArchive(new Uint8Array(gzipSync(Buffer.alloc(1024))), "apps/web")).toThrow();
  });
  it("Azure no longer refuses a subdirectory context", () => {
    expect(contextDirOf({ source: { contextDir: "apps/web" } }, "azure")).toBe("apps/web");
  });
});
