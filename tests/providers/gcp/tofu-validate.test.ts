/**
 * `tofu validate` over compiled GCP workspaces, against the real
 * hashicorp/google 8.5.0 schema. Gated behind ZENITH_TEST_TOFU_NETWORK=1 (and
 * a tofu binary): the first run downloads the provider from
 * registry.opentofu.org into the shared plugin cache. No cloud account is
 * used and nothing calls a cloud API; validate checks that every attribute and
 * block the drivers emit exists in the provider schema with a valid shape,
 * which is the ground truth for "compiles" (evidence stays `contract`).
 *
 * The plan test goes one step further and runs a real `tofu plan` with a
 * FAKE access token and every outbound HTTP(S) request pointed at a dead local
 * port: a plan that only creates resources needs no Google API call, so a
 * successful plan proves the provider accepts every value (enums, nested
 * blocks, `ignore_changes` paths, IAM conditions) at plan time and lets the
 * normalized plan be joined back to nodes. It is still `contract` evidence:
 * nothing is applied and nothing is read from a cloud.
 *
 *   ZENITH_TEST_TOFU_NETWORK=1 npx vitest run tests/providers/gcp/tofu-validate.test.ts
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { resolveTofuBinary } from "@/lib/tofu/binary";
import { TofuRunner } from "@/lib/tofu/runner";
import type { TofuWorkspace } from "@/lib/tofu/types";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { PROJECT, REGION, TAGS, compileContext, environmentNodes, graphOf, mk } from "./_fixtures";
import type { ResourceNode } from "@/lib/resources/types";

function tofuOnPath(): boolean {
  try {
    return spawnSync(resolveTofuBinary(), ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const enabled = process.env.ZENITH_TEST_TOFU_NETWORK === "1" && tofuOnPath();

function workspace(nodes = environmentNodes(), extra?: Map<string, TofuFragment>): TofuWorkspace {
  const fragments = compileContext(nodes).compileAll();
  for (const [k, v] of extra ?? []) fragments.set(k, v);
  return assembleWorkspace({
    graph: graphOf(nodes),
    fragments,
    providerSet: "gcp",
    region: REGION,
    backend: { kind: "local", path: path.join(os.tmpdir(), "zenith-gcp-validate-state", "terraform.tfstate") },
    tags: TAGS,
    providerConfig: { google: { project: PROJECT } },
  });
}

async function validate(ws: TofuWorkspace) {
  const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
  return runner.run(ws, {}, async (run) => {
    await run.init({ backend: false });
    return run.validate();
  });
}

describe.skipIf(!enabled)("tofu validate against hashicorp/google 8.5.0 (network)", () => {
  it(
    "accepts the full environment: network, data stores, identity, services, load balancer, dns, build",
    async () => {
      const r = await validate(workspace());
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(r.valid).toBe(true);
    },
    600_000
  );

  it(
    "accepts variants: no NAT, non-HA database, hourly redis backups, http-only load balancer, no backups, worker-only services",
    async () => {
      const nodes = environmentNodes().map((n) => {
        if (n.address === "network/main") return { ...n, spec: { ...n.spec, egress: { natGateways: "none" } } };
        if (n.address === "resource/db") return { ...n, spec: { ...n.spec, highAvailability: false, backup: "none", size: "nano", deletionPolicy: "allow" } };
        if (n.address === "resource/cache") return { ...n, spec: { ...n.spec, highAvailability: true, backup: "hourly" } };
        if (n.address === "resource/uploads") return { ...n, spec: { ...n.spec, versioning: false } };
        if (n.address === "load_balancer/public") return { ...n, dependsOn: ["service/web", "service/worker"], spec: { ...n.spec, listeners: [{ port: 80, protocol: "http" }] } };
        return n;
      });
      const r = await validate(workspace(nodes));
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(r.valid).toBe(true);
    },
    600_000
  );

  it(
    "accepts referenced nodes compiled to data sources",
    async () => {
      const refs: Record<string, string> = {
        "network/main": `projects/${PROJECT}/global/networks/legacy`,
        "resource/db": `projects/${PROJECT}/instances/legacy`,
        "resource/cache": `projects/${PROJECT}/locations/${REGION}/instances/legacy`,
        "resource/uploads": "legacy-bucket",
        "resource/jobs": `projects/${PROJECT}/topics/legacy`,
        "secret/api-key": `projects/${PROJECT}/secrets/legacy`,
        "resource/registry": `projects/${PROJECT}/locations/${REGION}/repositories/legacy`,
        "dns_zone/example.com": `projects/${PROJECT}/managedZones/legacy`,
        "tls_certificate/app.example.com": `projects/${PROJECT}/global/sslCertificates/legacy`,
        "job/nightly": `projects/${PROJECT}/locations/${REGION}/jobs/legacy`,
        "identity/web": `projects/${PROJECT}/serviceAccounts/legacy@${PROJECT}.iam.gserviceaccount.com`,
        "subnet/private-a": `projects/${PROJECT}/regions/${REGION}/subnetworks/legacy`,
      };
      const nodes = environmentNodes()
        .filter((n) => !["resource/pipeline", "dns_record/app.example.com", "load_balancer/public", "firewall/public"].includes(n.address))
        .map((n) => (refs[n.address] ? { ...n, ownership: "referenced" as const, externalRef: refs[n.address] } : n));
      const r = await validate(workspace(nodes));
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(r.valid).toBe(true);
    },
    600_000
  );

  it(
    "control: validate rejects an invalid attribute, so the passes above mean something",
    async () => {
      const nodes = [mk("resource/uploads", "object_store", { size: "small", versioning: true, publicAccess: false, deletionPolicy: "deny", encryption: true })];
      const bad: TofuFragment = { resource: { google_storage_bucket: { broken: { name: "x-bucket", location: "ASIA-SOUTH1", no_such_attribute: true } } }, addresses: ["google_storage_bucket.broken"] };
      const ws = workspace(nodes, new Map([["resource/uploads", bad]]));
      const r = await validate(ws);
      expect(r.valid).toBe(false);
      expect(r.diagnostics.some((d) => /no_such_attribute|not expected|unsupported argument/i.test(`${d.summary} ${d.detail ?? ""}`))).toBe(true);
    },
    600_000
  );

  it(
    "plans the whole environment offline with a fake token: every claimed resource is created, joined to its node, and no attribute is sensitive",
    async () => {
      // the queue reads a data source (`google_project`), which needs an API call; everything else does not
      const nodes: ResourceNode[] = environmentNodes()
        .filter((n) => n.address !== "resource/jobs")
        .map((n) => (n.address === "identity/web" ? { ...n, spec: { ...n.spec, grants: (n.spec.grants as { target: string }[]).filter((g) => g.target !== "resource/jobs") } } : n));
      const ws = workspace(nodes);
      await validate(ws); // populate the plugin cache while the network is reachable
      const dead = "http://127.0.0.1:9";
      const runner = new TofuRunner({ limits: { timeoutMs: 600_000 }, extraEnv: { HTTPS_PROXY: dead, HTTP_PROXY: dead, https_proxy: dead, http_proxy: dead } });
      const session = { childProcessEnv: () => ({ GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.fake-token-for-an-offline-plan-only", GOOGLE_PROJECT: PROJECT, GOOGLE_REGION: REGION }) };
      const plan = await runner.run(ws, { session }, async (run) => {
        await run.init();
        const p = await run.plan();
        expect(p.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        return run.normalizedPlan();
      });

      const claimed = Object.entries(ws.addressMap).flatMap(([node, addrs]) => addrs.filter((a) => !a.startsWith("data.")).map((a) => [a, node] as const));
      expect(claimed.length).toBeGreaterThan(40);
      expect(plan.resourceChanges.map((r) => r.address).sort()).toEqual(claimed.map(([a]) => a).sort());
      for (const rc of plan.resourceChanges) {
        expect(rc.action, rc.address).toBe("create");
        expect(rc.destroysData, rc.address).toBe(false);
        expect(rc.nodeAddress, rc.address).toBe(claimed.find(([a]) => a === rc.address)![1]);
        expect(rc.changes.filter((c) => c.sensitive), rc.address).toEqual([]);
        expect(rc.providerName).toBe("registry.opentofu.org/hashicorp/google");
      }
      expect(plan.summary).toMatchObject({ create: claimed.length, update: 0, delete: 0, replace: 0 });
      expect(JSON.stringify(plan)).not.toContain("ya29.");
    },
    900_000
  );
});
