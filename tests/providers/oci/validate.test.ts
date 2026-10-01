/**
 * `tofu validate` against the REAL pinned oracle/oci provider schema.
 *
 * Gated behind ZENITH_TEST_TOFU_NETWORK=1 (it installs the provider from
 * registry.opentofu.org through the committed lockfile; later runs reuse the
 * shared plugin cache). No OCI account or credentials exist or are used:
 * `validate` is static, so this proves the compiled JSON is schema-correct for
 * oracle/oci 9.7.1, NOT that a plan or apply would succeed in a tenancy.
 *
 *   ZENITH_TEST_TOFU_NETWORK=1 npx vitest run tests/providers/oci/validate.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TofuRunner } from "@/lib/tofu/runner";
import { assembleWorkspace, configDigestOf, lockDigestOf } from "@/lib/tofu/workspace";
import type { TofuWorkspace } from "@/lib/tofu/types";
import { tofuOnPath, tempDir } from "../../tofu/_helpers";
import { compileGraph, compiledNodes, expandOci, OCI_PROD, webStack, type CompiledGraph } from "./_support";

const enabled = process.env.ZENITH_TEST_TOFU_NETWORK === "1" && tofuOnPath();

function assemble(c: CompiledGraph, statePath: string) {
  const nodes = compiledNodes(c);
  return assembleWorkspace({
    graph: { ...c.graph, nodes },
    fragments: c.fragments,
    providerSet: "oci",
    region: "us-ashburn-1",
    backend: { kind: "local", path: statePath },
    tags: { "zenith:workspace": "ws_1", "zenith:environment": c.graph.environmentId, "zenith:managed": "true" },
  });
}

describe("assembly (no network)", () => {
  it("assembles a staging and a production OCI graph with the pinned oci provider set", () => {
    for (const env of [undefined, OCI_PROD]) {
      const c = compileGraph(expandOci(webStack(), env));
      const ws = assemble(c, "state/terraform.tfstate");
      expect(ws.files.map((f) => f.path)).toEqual(["backend.tf.json", "main.tf.json", "providers.tf.json", "versions.tf.json"]);
      const versions = JSON.parse(ws.files.find((f) => f.path === "versions.tf.json")!.content);
      expect(versions.terraform.required_providers.oci).toEqual({ source: "oracle/oci", version: "= 9.7.1" });
      expect(Object.keys(ws.addressMap).length).toBeGreaterThan(10);
    }
  });
});

describe.skipIf(!enabled)("tofu validate against oracle/oci 9.7.1 (network)", () => {
  it(
    "the whole web stack (network, LB, container instances, postgres, redis, bucket, queue, vault, identity, logs, dns) validates",
    async () => {
      const t = tempDir();
      try {
        const c = compileGraph(expandOci());
        const ws = assemble(c, path.join(t.dir, "state", "terraform.tfstate"));
        const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
        await runner.run(ws, {}, async (run) => {
          await run.init({ backend: false });
          const v = await run.validate();
          expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
          expect(v.valid).toBe(true);
        });
      } finally {
        t.cleanup();
      }
    },
    900_000
  );

  it(
    "the extended graph (host+path routing policy, container registry, block volume, no NAT, two zones) validates",
    async () => {
      const t = tempDir();
      try {
        const m = webStack();
        m.services.push({ ...m.services[0], id: "svc-api", name: "api", env: [], port: 8080, healthPath: "/health" });
        m.routes.push({ id: "rt-api", host: "app.acme.io", pathPrefix: "/api", tls: true, managedDns: true });
        m.bindings.push({ id: "b-api", from: "rt-api", to: "svc-api", capability: "http" });
        const base = expandOci(m, OCI_PROD);
        const net = base.nodes.find((n) => n.address === "network/main")!;
        const volume = { ...net, address: "volume/data", kind: "volume", nativeType: "oci:block_volume", spec: { sizeGb: 100, deletionPolicy: "deny" }, dependsOn: [] } as typeof net;
        const noNat = { ...net, spec: { ...net.spec, egress: { natGateways: "none" } } };
        const registry = { ...net, address: "container_registry/worker", kind: "container_registry", nativeType: "oci:container_repository", spec: { scanOnPush: true, immutableTags: false }, dependsOn: [] } as typeof net;
        const graph = { ...base, nodes: [...base.nodes.map((n) => (n.address === "network/main" ? noNat : n)), volume, registry] };
        const c = compileGraph(graph);
        expect([...c.fragments.keys()]).toEqual(expect.arrayContaining(["container_registry/worker", "volume/data", "load_balancer/public"]));
        const policy = Object.keys(c.fragments.get("load_balancer/public")!.resource ?? {});
        expect(policy).toContain("oci_load_balancer_load_balancer_routing_policy");
        const ws = assemble(c, path.join(t.dir, "state", "terraform.tfstate"));
        const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
        await runner.run(ws, {}, async (run) => {
          await run.init({ backend: false });
          const v = await run.validate();
          expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
          expect(v.valid).toBe(true);
        });
      } finally {
        t.cleanup();
      }
    },
    900_000
  );

  it(
    "negative control: a wrong argument in a compiled fragment makes validate fail (the gate has teeth)",
    async () => {
      const t = tempDir();
      try {
        const c = compileGraph(expandOci());
        const vcn = c.fragments.get("network/main")!;
        const body = Object.values(vcn.resource!.oci_core_vcn)[0] as Record<string, unknown>;
        body.not_a_real_argument = true;
        const ws = assemble(c, path.join(t.dir, "state", "terraform.tfstate"));
        const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
        await runner.run(ws, {}, async (run) => {
          await run.init({ backend: false });
          const v = await run.validate();
          expect(v.valid).toBe(false);
          expect(v.diagnostics.some((d) => d.severity === "error" && /not_a_real_argument|unsupported argument/i.test(`${d.summary} ${d.detail ?? ""}`))).toBe(true);
        });
      } finally {
        t.cleanup();
      }
    },
    900_000
  );
});

describe.skipIf(!enabled)("the customer bootstrap module (deploy/oci) validates against the locked provider (network)", () => {
  it(
    "tofu validate accepts deploy/oci with its shipped lockfile",
    async () => {
      const dir = path.join(process.cwd(), "deploy", "oci");
      const lf = (text: string) => text.split("\r\n").join("\n"); // the working tree may be CRLF on Windows
      const files = ["main.tf", "outputs.tf", "variables.tf", "versions.tf"].map((f) => ({ path: f, content: lf(fs.readFileSync(path.join(dir, f), "utf8")) }));
      const lockfile = lf(fs.readFileSync(path.join(dir, ".terraform.lock.hcl"), "utf8"));
      const ws: TofuWorkspace = { files, lockfile, configDigest: configDigestOf(files), lockDigest: lockDigestOf(lockfile), addressMap: {}, backend: "local" };
      const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
      await runner.run(ws, {}, async (run) => {
        await run.init({ backend: false });
        const v = await run.validate();
        expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        expect(v.valid).toBe(true);
      });
    },
    900_000
  );
});
