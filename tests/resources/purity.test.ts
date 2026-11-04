import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `src/lib/resources` is L0: pure. No fs, no env, no network, no store, and it
 * may not reach up into `@/app`. `node:crypto` is allowed only through
 * `@/lib/controlplane/digest`. A cycle among its own modules would make the
 * barrel order-dependent.
 */
const DIR = path.join(process.cwd(), "src", "lib", "resources");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".ts"));
const source = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8");
const importsOf = (text: string): string[] =>
  [...text.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);

const ALLOWED_EXTERNAL = new Set(["zod", "@/lib/domain/types", "@/lib/cost/pricing", "@/lib/controlplane/digest"]);

describe("resources module purity", () => {
  it("has the files the barrel promises", () => {
    for (const f of ["manifest-v2.ts", "upgrade.ts", "expand.ts", "drift.ts", "index.ts", "types.ts", "native-types.ts", "native-registry.ts"])
      expect(files).toContain(f);
  });

  it("imports only zod, the V1 domain types, pricing constants, the digest rule, and itself", () => {
    for (const f of files)
      for (const spec of importsOf(source(f))) {
        const ok = spec.startsWith("./") || ALLOWED_EXTERNAL.has(spec);
        expect(ok, `${f} imports ${spec}`).toBe(true);
      }
  });

  it("never touches fs, env, processes, the network or randomness", () => {
    const banned = [/process\.env/, /["']node:/,/from\s+["']fs["']/, /child_process/, /\bfetch\(/, /Math\.random/, /Date\.now/, /require\(/];
    for (const f of files) for (const re of banned) expect(re.test(source(f)), `${f} matches ${re}`).toBe(false);
  });

  it("`new Date()` appears only where a caller can inject the clock (drift's default)", () => {
    for (const f of files) {
      const hits = source(f).match(/new Date\(/g) ?? [];
      expect(hits.length, f).toBe(f === "drift.ts" ? 1 : 0);
    }
  });

  it("has no import cycles among its own modules", () => {
    const graph = new Map(files.map((f) => [f, importsOf(source(f)).filter((s) => s.startsWith("./")).map((s) => `${s.slice(2)}.ts`)]));
    const state = new Map<string, number>();
    const visit = (f: string, trail: string[]): string[] | undefined => {
      if (state.get(f) === 2) return undefined;
      if (state.get(f) === 1) return [...trail, f];
      state.set(f, 1);
      for (const d of graph.get(f) ?? []) {
        expect(graph.has(d), `${f} imports missing ${d}`).toBe(true);
        const c = visit(d, [...trail, f]);
        if (c) return c;
      }
      state.set(f, 2);
      return undefined;
    };
    for (const f of graph.keys()) expect(visit(f, []), `cycle from ${f}`).toBeUndefined();
  });

  it("keeps every file under 600 lines", () => {
    for (const f of files) expect(source(f).split("\n").length, f).toBeLessThan(600);
  });
});
