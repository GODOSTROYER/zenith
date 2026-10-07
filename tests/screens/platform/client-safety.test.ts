/**
 * The platform components ship in the browser bundle, so they must never import
 * server-only runtime code. This test reads the sources and enforces it: no
 * `node:` import, no runtime import from the control-plane digest, the resources
 * barrel, the tofu runner or plan normalizer, the policy engine, the placement
 * price book, the credential broker or the database layer, and contracts come in
 * through `import type` only. It also keeps hardcoded colours out.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "src", "components", "platform");
const files = readdirSync(DIR).filter((f) => /\.(ts|tsx)$/.test(f));

/** Modules whose runtime code pulls node: APIs or engines. `import type` from them is fine. */
const SERVER_ONLY = [
  "@/lib/controlplane/digest",
  "@/lib/controlplane/db",
  "@/lib/runners/lifecycle",
  "@/lib/platform/operator-journey",
  "@/lib/resources", // the barrel and anything under it at runtime
  "@/lib/tofu/",
  "@/lib/policy/",
  "@/lib/placement/",
  "@/lib/credentials/",
  "@/lib/drivers/",
  "@/lib/incidents/",
  "@/lib/capabilities/",
  "@/lib/workflows/",
  "@/lib/machines/",
  "@/lib/observability/",
  "@/lib/providers/",
];

const importsOf = (src: string): { line: string; spec: string; typeOnly: boolean }[] =>
  [...src.matchAll(/^\s*(import|export)\s+([^;]*?)\s+from\s+["']([^"']+)["']/gms)].map((m) => ({
    line: m[0].trim().split("\n")[0],
    spec: m[3],
    typeOnly: /^(import|export)\s+type\b/.test(m[0].trim()),
  }));

describe("src/components/platform is client-safe", () => {
  it("keeps the shared AWS bootstrap input module free of dependencies and environment APIs", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/aws-bootstrap-input.ts"), "utf8");
    expect(importsOf(src)).toEqual([]);
    expect(src).not.toMatch(/^\s*import\s*["']|\b(?:import|require)\s*\(/gm);
    expect(src).not.toMatch(/\b(?:process|Buffer|globalThis|window|document|fetch|XMLHttpRequest|WebSocket|eval|Deno|Bun)\b|node:|child_process|server-only|@\/lib\/(?:credentials|execution)\//);
  });

  it("looks at the files it claims to", () => {
    expect(files.length).toBeGreaterThan(25);
    expect(files).toContain("approval-eligibility.ts");
  });

  it.each(files)("%s imports no node: API and no server-only module at runtime", (file) => {
    const src = readFileSync(join(DIR, file), "utf8");
    const offenders: string[] = [];
    for (const imp of importsOf(src)) {
      if (imp.spec.startsWith("node:")) offenders.push(`${imp.line}  (node API)`);
      if (!imp.typeOnly && SERVER_ONLY.some((p) => imp.spec === p.replace(/\/$/, "") || imp.spec.startsWith(p))) {
        offenders.push(`${imp.line}  (runtime import of server code)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(files)("%s does not reach for process.env, fs or child_process", (file) => {
    const src = readFileSync(join(DIR, file), "utf8");
    expect(src).not.toMatch(/process\.env|require\(["']fs|child_process|from ["']fs["']/);
  });

  it.each(files.filter((f) => f.endsWith(".tsx")))("%s hardcodes no colour", (file) => {
    const src = readFileSync(join(DIR, file), "utf8");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
    expect(src).not.toMatch(/\b(?:text|bg|border|ring|fill|stroke)-(?:red|green|blue|amber|yellow|orange|gray|slate|zinc|neutral|emerald|rose|sky|violet|purple)-\d{2,3}\b/);
    expect(src).not.toMatch(/\brgba?\(/);
  });

  it("imports only from the kit, screens badges, and its own folder among components", () => {
    const allowed = /^(@\/components\/ui\/|@\/components\/screens\/badges$|\.\/|@\/lib\/(format|controlplane\/types|resources\/types|incidents\/types|placement\/types|policy\/types|credentials\/types|tofu\/types|tofu\/plan|capabilities\/catalog|aws-bootstrap-input)$)/;
    const offenders: string[] = [];
    for (const file of files) {
      for (const imp of importsOf(readFileSync(join(DIR, file), "utf8"))) {
        if (imp.spec.startsWith("react") || imp.spec === "lucide-react") continue;
        if (imp.typeOnly && ["@/lib/runners/lifecycle", "@/lib/platform/operator-journey", "@/lib/effects/view", "@/lib/effects/types", "@/lib/placement/feasibility"].includes(imp.spec)) continue;
        if (!allowed.test(imp.spec)) offenders.push(`${file}: ${imp.spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
