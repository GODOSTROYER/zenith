/**
 * The fixture is built for real, with the pinned recipe, into a throwaway
 * directory: vite@7.3.6 + @vitejs/plugin-react@5.1.4, no config file of its
 * own, no env file, nothing from this repository leaking in.
 *
 * What it proves: the package a builder would upload compiles as submitted,
 * emits hashed immutable assets and an entry HTML with no inline script, and
 * stays small enough to serve from an app host.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const root = path.join(repo, "fixtures", "tracker-app");

let outDir = "";
let priorNodeEnv: string | undefined;

/** NODE_ENV is typed read-only for application code; a build harness may set it. */
const env = process.env as Record<string, string | undefined>;
let emitted: { rel: string; bytes: number }[] = [];
let indexHtml = "";

function walk(dir: string, base = ""): { rel: string; bytes: number }[] {
  const found: { rel: string; bytes: number }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...walk(full, rel));
    else found.push({ rel, bytes: fs.statSync(full).size });
  }
  return found;
}

describe("the tracker fixture builds with the pinned recipe", () => {
  beforeAll(async () => {
    outDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tracker-build-"));
    // Vite decides between the development and production entries of React by
    // NODE_ENV, which the test runner has already set to "test". A build server
    // would be in production; say so, or the bundle is twice the size and is
    // not the artifact anyone would ship.
    priorNodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    await build({
      root,
      configFile: false,
      envFile: false,
      mode: "production",
      logLevel: "warn",
      plugins: [react()],
      resolve: { dedupe: ["react", "react-dom"] },
      build: { outDir, emptyOutDir: true },
    });
    emitted = walk(outDir);
    indexHtml = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  }, 180_000);

  afterAll(async () => {
    if (priorNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = priorNodeEnv;
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("emits an entry document and hashed assets", async () => {
    const names = emitted.map((file) => file.rel);
    expect(names).toContain("index.html");
    expect(names).toContain("favicon.svg");

    const js = names.filter((name) => /^assets\/.+\.js$/.test(name));
    const css = names.filter((name) => /^assets\/.+\.css$/.test(name));
    expect(js.length).toBeGreaterThan(0);
    expect(css.length).toBeGreaterThan(0);
    for (const name of [...js, ...css]) {
      expect(name, `${name} carries no content hash`).toMatch(/-[A-Za-z0-9_-]{8}\.(js|css)$/);
      expect(indexHtml).toContain(`/${name}`);
    }
  });

  it("ships no source maps", async () => {
    expect(emitted.filter((file) => file.rel.endsWith(".map"))).toEqual([]);
  });

  it("puts no inline script in the entry document", async () => {
    const scripts = indexHtml.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag, `inline script: ${tag}`).toMatch(/\ssrc=/);
    }
    expect(indexHtml).not.toMatch(/<script[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/);
    expect(indexHtml).not.toMatch(/\son[a-z]+=/i);
  });

  it("asks for nothing from another origin", async () => {
    const external = indexHtml.match(/(?:src|href)="https?:\/\/[^"]+"/g) ?? [];
    expect(external).toEqual([]);
  });

  it("stays under 400 KB in total", async () => {
    const total = emitted.reduce((sum, file) => sum + file.bytes, 0);
    expect(total, `emitted ${total} bytes`).toBeLessThan(400 * 1024);
  });
});
