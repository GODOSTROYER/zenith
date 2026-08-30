import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { importCompose } from "@/lib/importers/compose";

const FIXTURE = path.join(process.cwd(), "fixtures", "sample-app", "docker-compose.yml");
const yamlText = fs.readFileSync(FIXTURE, "utf8");
const { manifest, report } = importCompose(yamlText);

const kindOf = (name: string) => manifest.resources.find((r) => r.name === name)?.kind;

describe("compose importer", () => {
  it("maps the sample app to the expected node set", () => {
    expect(manifest.services.map((s) => `${s.name}:${s.kind}`).sort()).toEqual(["web:web", "worker:worker"]);
    expect(kindOf("postgres")).toBe("postgres");
    expect(kindOf("redis")).toBe("redis");
    expect(kindOf("rabbitmq")).toBe("queue");
    expect(kindOf("minio")).toBe("object_store");
    expect(kindOf("mailhog")).toBe("email");
    expect(manifest.resources).toHaveLength(5);
  });

  it("reads the port from the ports mapping", () => {
    expect(manifest.services.find((s) => s.name === "web")!.port).toBe(3000);
    expect(manifest.services.find((s) => s.name === "web")!.healthPath).toBe("/healthz");
  });

  it("infers connections from depends_on and env values, with capabilities", () => {
    const edge = (from: string, to: string) => {
      const f = manifest.services.find((s) => s.name === from)!;
      const t = [...manifest.services, ...manifest.resources].find((n) => n.name === to)!;
      return manifest.bindings.find((b) => b.from === f.id && b.to === t.id);
    };
    expect(edge("web", "postgres")).toMatchObject({ capability: "sql" });
    expect(edge("web", "redis")).toMatchObject({ capability: "cache" });
    expect(edge("web", "minio")).toMatchObject({ capability: "blob" });
    expect(edge("web", "mailhog")).toMatchObject({ capability: "smtp" });
    expect(edge("worker", "rabbitmq")).toMatchObject({ capability: "queue_publish" });
    expect(manifest.bindings.every((b) => (b.note ?? "").length > 0)).toBe(true);
    // one edge per pair, however many signals pointed at it
    const pairs = manifest.bindings.map((b) => `${b.from}->${b.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("never puts a secret-looking value in the manifest", () => {
    const web = manifest.services.find((s) => s.name === "web")!;
    const secret = web.env.find((e) => e.key === "SESSION_SECRET")!;
    expect(secret.secretRef).toBe("vault:SESSION_SECRET");
    expect(secret.value).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain("dev-only-not-a-real-secret");
    expect(JSON.stringify(manifest)).not.toContain("dev-only-not-a-real-key");
    expect(web.env.find((e) => e.key === "NODE_ENV")!.value).toBe("production");
  });

  it("drops nothing silently: every compose key is mapped or explained", () => {
    const doc = load(yamlText) as Record<string, unknown>;
    const accounted = (source: string) =>
      report.mapped.some((x) => x.source === source) || report.unmapped.some((x) => x.source === source);

    for (const topKey of Object.keys(doc)) {
      if (topKey === "services") continue;
      expect(accounted(topKey), `top-level "${topKey}" is unaccounted for`).toBe(true);
    }

    const services = doc.services as Record<string, Record<string, unknown>>;
    for (const [name, body] of Object.entries(services)) {
      expect(accounted(`services.${name}`), `service "${name}" is unaccounted for`).toBe(true);
      for (const key of Object.keys(body)) {
        if (key === "image" || key === "build" || key === "ports" || key === "depends_on" || key === "healthcheck") continue;
        if (key === "environment") {
          for (const varKey of envKeys(body.environment)) {
            const source = `services.${name}.environment.${varKey}`;
            const inService = manifest.services.some((s) => s.env.some((e) => e.key === varKey));
            expect(accounted(source) || inService, `${source} is unaccounted for`).toBe(true);
          }
          continue;
        }
        expect(accounted(`services.${name}.${key}`), `services.${name}.${key} is unaccounted for`).toBe(true);
      }
    }
  });

  it("warns about what needs a human before deploying", () => {
    const all = report.warnings.join(" ");
    expect(all).toMatch(/git repository|build context/i); // web/worker build from "."
    expect(all).toMatch(/SESSION_SECRET/);
    expect(all).toMatch(/route/i); // nothing is published yet
  });

  it("rejects input that is not a compose file, with a fix in the message", () => {
    expect(() => importCompose("just some text")).toThrow(/docker-compose\.yml/);
    expect(() => importCompose("services:\n  - broken: [")).toThrow(/YAML/i);
  });
});

function envKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((e) => String(e).split("=")[0].trim());
  if (raw && typeof raw === "object") return Object.keys(raw as Record<string, unknown>);
  return [];
}
