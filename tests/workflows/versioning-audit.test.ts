/**
 * PROD-OPS-03 static audit of Temporal workflow versioning. No server, no bundler:
 * it reads the workflow sources and compares them with the registry in
 * src/lib/workflows/versioning.ts, so an unregistered patch, a new unregistered
 * workflow type, or a stale registry entry fails the build.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTERED_WORKFLOW_TYPES, WORKFLOW_PATCHES } from "@/lib/workflows/versioning";
import { WORKFLOW_TYPES } from "@/lib/workflows/types";

const DEFINITIONS = path.resolve(__dirname, "../../src/lib/workflows/definitions");
const sources = readdirSync(DEFINITIONS).filter((f) => f.endsWith(".ts")).map((file) => ({ file, text: readFileSync(path.join(DEFINITIONS, file), "utf8") }));
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function patchCalls(): Array<{ id: string; fn: "patched" | "deprecatePatch"; file: string }> {
  const out: Array<{ id: string; fn: "patched" | "deprecatePatch"; file: string }> = [];
  for (const { file, text } of sources) {
    const code = stripComments(text);
    for (const m of code.matchAll(/\b(patched|deprecatePatch)\(\s*(["'`])([^"'`]+)\2\s*\)/g)) out.push({ fn: m[1] as "patched" | "deprecatePatch", id: m[3]!, file });
    // A non-literal id cannot be audited and is forbidden.
    expect(/\b(patched|deprecatePatch)\(\s*[^"'`\s)]/.test(code), `${file} passes a non-literal patch id`).toBe(false);
  }
  return out;
}

describe("patched()/deprecatePatch() audit", () => {
  it("every patch marker in definitions/ is registered with the workflow that contains it", () => {
    const calls = patchCalls();
    expect(calls.length, "the audit must see the existing patch markers").toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      const entry = WORKFLOW_PATCHES.find((p) => p.id === call.id);
      expect(entry, `${call.fn}("${call.id}") in ${call.file} is not in WORKFLOW_PATCHES`).toBeDefined();
      const owner = sources.find((s) => s.file === call.file)!.text;
      expect(owner, `${call.id} is registered to ${entry!.workflow}, which ${call.file} does not export`).toMatch(new RegExp(`export async function ${entry!.workflow}\\b`));
      expect(call.fn, `${call.id} status ${entry!.status} does not match ${call.fn}`).toBe(entry!.status === "active" ? "patched" : "deprecatePatch");
    }
  });

  it("every registry entry is still present in the code (remove it with the deprecation, not before)", () => {
    const calls = patchCalls();
    for (const entry of WORKFLOW_PATCHES) expect(calls.some((c) => c.id === entry.id), `${entry.id} is registered but no patched()/deprecatePatch() uses it`).toBe(true);
    expect(new Set(WORKFLOW_PATCHES.map((p) => p.id)).size, "patch ids are unique").toBe(WORKFLOW_PATCHES.length);
    for (const entry of WORKFLOW_PATCHES) expect(entry.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*-v\d+$/);
  });
});

describe("registered workflow types", () => {
  const index = stripComments(readFileSync(path.join(DEFINITIONS, "index.ts"), "utf8"));
  const exported = [...index.matchAll(/export\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from/g)].map((m) => m[1]!);

  it("definitions/index.ts exports exactly the registered workflow types", () => {
    expect([...exported].sort()).toEqual([...REGISTERED_WORKFLOW_TYPES].sort());
  });

  it("every registered type is startable by name from WORKFLOW_TYPES", () => {
    expect(Object.values(WORKFLOW_TYPES).sort()).toEqual([...REGISTERED_WORKFLOW_TYPES].sort());
  });

  it("every registered type is a real exported async function in definitions/", () => {
    const all = sources.map((s) => s.text).join("\n");
    for (const type of REGISTERED_WORKFLOW_TYPES) expect(all, type).toMatch(new RegExp(`export async function ${type}\\b`));
  });
});
