/**
 * `tofu validate` over compiled GCP workspaces, against the real
 * hashicorp/google 8.5.0 schema. Gated behind ZENITH_TEST_TOFU_NETWORK=1 (and
 * a tofu binary): the first run downloads the provider from
 * registry.opentofu.org into the shared plugin cache. No cloud account is
 * used and nothing calls a cloud API; validate checks that every attribute and
 * block the drivers emit exists in the provider schema with a valid shape,
 * which is the ground truth for "compiles" (evidence stays `contract`).
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
});
