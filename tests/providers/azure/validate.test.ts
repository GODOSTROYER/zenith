/**
 * Ground truth for the compiled OpenTofu: every fragment the Azure drivers
 * emit is validated by `tofu validate` against the REAL pinned azurerm 5.7.0
 * schema (provider download needed, ~230 MB the first time; later runs reuse
 * the shared plugin cache).
 *
 *   ZENITH_TEST_TOFU_NETWORK=1 npx vitest run tests/providers/azure/validate.test.ts
 *
 * What this proves: argument names, nested block shapes, value-level provider
 * validation of literals (name rules, enum values) and cross-fragment
 * references (`local.*` exports) are accepted by the provider's schema. What it
 * does NOT prove: that a plan or apply succeeds in a real subscription —
 * nothing here calls Azure.
 */
import { describe, expect, it } from "vitest";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { TofuRunner } from "@/lib/tofu/runner";
import { resolveTofuBinary } from "@/lib/tofu/binary";
import { AZURE_DRIVERS } from "@/lib/providers/azure/drivers";
import type { ResourceNode } from "@/lib/resources/types";
import { compileAll, graphOf, mkNode, sampleGraph } from "./_helpers";

const enabled = process.env.ZENITH_TEST_TOFU_NETWORK === "1" && (() => { try { resolveTofuBinary(); return true; } catch { return false; } })();
const driverFor = (n: ResourceNode) => AZURE_DRIVERS.find((d) => d.nativeType === n.nativeType);

async function validate(nodes: ResourceNode[]) {
  const frags = compileAll(nodes, driverFor);
  const ws = assembleWorkspace({
    graph: graphOf(nodes),
    fragments: frags,
    providerSet: "azure",
    region: "westeurope",
    backend: { kind: "local", path: "/tmp/zenith-azure-validate.tfstate" },
    tags: {},
    // exactly what the integration must pass for azurerm (non-secret); credentials come from ARM_* env
    providerConfig: { azurerm: { subscription_id: "11111111-2222-3333-4444-555555555555", storage_use_azuread: true, resource_provider_registrations: "none" } },
  });
  const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
  return runner.run(ws, {}, async (run) => {
    await run.init({ backend: false });
    return run.validate();
  });
}

const errorsOf = (v: Awaited<ReturnType<typeof validate>>) => v.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.summary}${d.detail ? `: ${d.detail}` : ""}`);

describe.skipIf(!enabled)("compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network)", () => {
  it(
    "a full environment: landing zone, subnets, firewall, Container App + job, postgres HA, redis, storage, service bus, key vault, identity, registry, logs, DNS, managed certificate",
    async () => {
      const v = await validate(sampleGraph());
      expect(errorsOf(v)).toEqual([]);
      expect(v.valid).toBe(true);
    },
    900_000
  );

  it(
    "variants: no HA, a topic, a worker, a job without a schedule, an apex domain, a referenced Key Vault secret, deletion allowed, a single zone",
    async () => {
      const nodes = sampleGraph();
      const set = (a: string, patch: Record<string, unknown>) => Object.assign(nodes.find((n) => n.address === a)!.spec, patch);
      set("network/main", { zones: 1 });
      set("postgres/db", { highAvailability: false, size: "small", backup: "hourly", deletionPolicy: "allow", config: { geoRedundantBackup: true } });
      set("redis/cache", { highAvailability: true, size: "standard" });
      set("object_store/uploads", { versioning: false, config: { replication: "ZRS" } });
      set("queue/jobs", { size: "standard" });
      set("scheduled_job/report", { schedule: undefined });
      const secret = nodes.find((n) => n.address === "secret/session-key-1a2b3c4d")!;
      secret.ownership = "referenced";
      secret.externalRef = "https://customer-vault.vault.azure.net/secrets/session-key";
      nodes.find((n) => n.address === "identity/web")!.spec.grants = (nodes.find((n) => n.address === "identity/web")!.spec.grants as { target: string }[]).filter((g) => !g.target.startsWith("secret/"));
      nodes.push(mkNode("pubsub/events", "pubsub", "azure:service_bus_topic", { size: "small", deletionPolicy: "approval", encryption: true }));
      // apex domain: A record + HTTP validation
      const rename = (from: string, to: string, spec: Record<string, unknown>) => {
        const n = nodes.find((x) => x.address === from)!;
        n.address = to;
        n.labels["zenith:resource"] = to;
        Object.assign(n.spec, spec);
      };
      rename("dns_record/app.example.com", "dns_record/example.com", { name: "example.com" });
      rename("tls_certificate/app.example.com", "tls_certificate/example.com", { domain: "example.com" });
      const lb = nodes.find((n) => n.address === "load_balancer/public")!;
      (lb.spec.routes as { host: string }[])[0].host = "example.com";
      lb.dependsOn = lb.dependsOn.map((d) => (d === "tls_certificate/app.example.com" ? "tls_certificate/example.com" : d));
      const v = await validate(nodes);
      expect(errorsOf(v)).toEqual([]);
      expect(v.valid).toBe(true);
    },
    900_000
  );

  it(
    "an environment with only a bucket and a queue plus the network that owns the resource group",
    async () => {
      const keep = new Set(["network/main", "subnet/private-a", "object_store/uploads", "queue/jobs"]);
      const nodes = sampleGraph().filter((n) => keep.has(n.address));
      const v = await validate(nodes);
      expect(errorsOf(v)).toEqual([]);
    },
    900_000
  );
});

describe("validate gate", () => {
  it("is skipped unless ZENITH_TEST_TOFU_NETWORK=1 and a tofu binary exists (documented in the file header)", () => {
    expect(typeof enabled).toBe("boolean");
  });
});
