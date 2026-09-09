/**
 * The fixture is checked against the supported source contract directly, with
 * the contract constants and nothing else. W2 is building the intake validator
 * at the same time; if this test imported it, the two could agree with each
 * other and both be wrong about the rules.
 *
 * Workstream W4 (hosted R3)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_DEPENDENCIES,
  ALLOWED_EXTENSIONS,
  ALLOWED_ROOT_DIRS,
  ALLOWED_ROOT_FILES,
  REJECTED_PATTERNS,
  SOURCE_LIMITS,
  SourceManifest,
  SourcePackageJson,
} from "@/lib/hosted/contracts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..", "fixtures", "tracker-app");

interface Entry {
  rel: string;
  bytes: number;
}

function collect(dir: string, base = ""): Entry[] {
  const found: Entry[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collect(full, rel));
    else found.push({ rel, bytes: fs.statSync(full).size });
  }
  return found;
}

const files = collect(root);
const paths = files.map((file) => file.rel);
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");

describe("the fixture is a supported source package", () => {
  it("declares the manifest the contract asks for", () => {
    const manifest = SourceManifest.parse(JSON.parse(read("zenith.app.json")));
    expect(manifest).toEqual({ contract: 1, name: "Equipment requests", schema: 1, entry: "index.html" });
  });

  it("submits a package.json that is metadata only", () => {
    const raw: unknown = JSON.parse(read("package.json"));
    const parsed = SourcePackageJson.parse(raw);
    expect(parsed.type).toBe("module");
    expect(parsed.private).toBe(true);
    expect(Object.keys(parsed.dependencies ?? {}).sort()).toEqual(["react", "react-dom"]);
    for (const name of Object.keys(parsed.dependencies ?? {})) {
      expect(ALLOWED_DEPENDENCIES.has(name), `${name} is not a supported dependency`).toBe(true);
    }
    const keys = Object.keys(raw as Record<string, unknown>);
    for (const forbidden of ["scripts", "devDependencies", "workspaces", "overrides", "resolutions"]) {
      expect(keys, `package.json must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("keeps only the root files and directories the contract allows", () => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        expect(ALLOWED_ROOT_DIRS.has(entry.name), `unexpected root directory ${entry.name}`).toBe(true);
      } else {
        expect(ALLOWED_ROOT_FILES.has(entry.name), `unexpected root file ${entry.name}`).toBe(true);
      }
    }
    expect(paths).toContain("index.html");
    expect(paths).toContain("src/main.tsx");
    expect(read("index.html")).toContain('src="/src/main.tsx"');
  });

  it("uses only allowed extensions under src/ and public/", () => {
    for (const rel of paths) {
      const [top] = rel.split("/");
      if (!ALLOWED_ROOT_DIRS.has(top)) continue;
      const ext = path.extname(rel).toLowerCase();
      expect(ALLOWED_EXTENSIONS.has(ext), `${rel} has an unsupported extension`).toBe(true);
    }
  });

  it("matches none of the rejected patterns", () => {
    for (const rel of paths) {
      for (const pattern of REJECTED_PATTERNS) {
        expect(pattern.test(rel), `${rel} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("stays inside the source limits", () => {
    expect(files.length).toBeLessThanOrEqual(SOURCE_LIMITS.maxFiles);
    const total = files.reduce((sum, file) => sum + file.bytes, 0);
    expect(total).toBeLessThanOrEqual(SOURCE_LIMITS.maxTotalBytes);
    for (const file of files) {
      expect(file.bytes, `${file.rel} is too large`).toBeLessThanOrEqual(SOURCE_LIMITS.maxFileBytes);
      expect(file.rel.length, `${file.rel} has too long a path`).toBeLessThanOrEqual(
        SOURCE_LIMITS.maxPathLength
      );
      expect(file.rel.split("/").length, `${file.rel} nests too deeply`).toBeLessThanOrEqual(
        SOURCE_LIMITS.maxDepth
      );
    }
  });

  it("carries no build configuration of its own", () => {
    for (const name of ["vite.config.ts", "vite.config.js", "tsconfig.json", "package-lock.json", ".env"]) {
      expect(fs.existsSync(path.join(root, name)), `${name} must not be submitted`).toBe(false);
    }
  });

  it("is stored with LF line endings", () => {
    const text = new Set([".ts", ".tsx", ".css", ".html", ".json", ".svg", ".md", ".txt"]);
    for (const rel of paths) {
      if (!text.has(path.extname(rel).toLowerCase())) continue;
      expect(read(rel).includes("\r"), `${rel} has CRLF line endings`).toBe(false);
    }
  });
});
