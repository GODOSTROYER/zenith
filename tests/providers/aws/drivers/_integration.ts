/** Real expansion and driver compilation fixtures; SDK reads remain mocked. */
import { expect } from "vitest";
import { findDriver, type CompileContext, type TofuFragment } from "@/lib/drivers/types";
import { NOT_YET_IMPLEMENTED, registerAwsDrivers } from "@/lib/providers/aws/drivers";
import { refLocalName } from "@/lib/providers/aws/drivers/shared";
import { expandManifest, upgradeManifest, type ExpandEnv, type ResourceGraph } from "@/lib/resources";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { bind, manifest, res, route, svc } from "../../../resources/_fixtures";

export const SECRET_CANARY = "CANARY-secret-value-must-never-reach-a-workspace";
export const REGION = "ap-south-1";
export const TAGS = { "zenith:workspace": "ws_integration", "zenith:environment": "env_integration", "zenith:managed": "true" };

export function realisticManifest() {
  return manifest({
    services: [
      svc({ id: "web", name: "web", kind: "web", replicas: 2, port: 3000, healthPath: "/healthz",
        source: { type: "git", repo: "https://github.com/acme/web", ref: "main", dockerfile: "Dockerfile" },
        env: [{ key: "API_KEY", value: SECRET_CANARY, secretRef: "vault:ws_integration/API_KEY" }, { key: "NODE_ENV", value: "production" }] }),
      svc({ id: "worker", name: "worker", kind: "worker", source: { type: "image", image: "ghcr.io/acme/worker:1.0.0" },
        env: [{ key: "API_KEY", secretRef: "vault:ws_integration/API_KEY" }] }),
    ],
    resources: [
      res({ id: "db", name: "db", kind: "postgres" }),
      res({ id: "cache", name: "cache", kind: "redis" }),
      res({ id: "uploads", name: "uploads", kind: "object_store" }),
      res({ id: "jobs", name: "jobs", kind: "queue" }),
    ],
    routes: [route({ id: "route", host: "app.acme.io" })],
    bindings: [bind("http", "route", "web", "http"), bind("sql", "web", "db", "sql"), bind("cache-web", "web", "cache", "cache"),
      bind("cache-worker", "worker", "cache", "cache"), bind("blob", "web", "uploads", "blob"),
      bind("publish", "web", "jobs", "queue_publish"), bind("consume", "worker", "jobs", "queue_consume")],
  });
}

export function expanded(envClass: ExpandEnv["class"]): ResourceGraph {
  const env: ExpandEnv = { id: TAGS["zenith:environment"], name: envClass, class: envClass, provider: "aws", region: REGION, baseDomain: "acme.io" };
  return expandManifest(upgradeManifest(realisticManifest(), { provider: "aws", region: REGION }), env);
}

export function compileContext(graph: Pick<ResourceGraph, "nodes" | "environmentId">): CompileContext {
  return {
    environmentId: graph.environmentId, namePrefix: "zen-integration", region: REGION, tags: TAGS,
    node: (address) => graph.nodes.find((n) => n.address === address),
    ref: (address, attribute) => {
      expect(graph.nodes.some((n) => n.address === address), `reference to absent node ${address}`).toBe(true);
      return `\${local.${refLocalName(address, attribute)}}`;
    },
  };
}

export function compiled(envClass: "production" | "staging") {
  registerAwsDrivers();
  const graph = expanded(envClass);
  const ctx = compileContext(graph);
  ctx.tags = { ...TAGS, "zenith:env-class": envClass };
  const fragments = new Map<string, TofuFragment>();
  for (const node of graph.nodes) {
    const driver = findDriver("aws", node.nativeType);
    if (!driver) {
      expect(NOT_YET_IMPLEMENTED.has(node.nativeType), `no driver or explicit gap for ${node.address}`).toBe(true);
      continue;
    }
    // Referenced zones contribute real data-source fragments, needed by TLS/DNS.
    const fragment = driver.compile!(node, ctx);
    if (node.ownership === "managed") expect(fragment.addresses.length, node.address).toBeGreaterThan(0);
    fragments.set(node.address, fragment);
  }
  const workspace = assembleWorkspace({ graph, fragments, providerSet: "aws", region: REGION, tags: ctx.tags,
    backend: { kind: "s3", bucket: "zenith-integration-state" }, stateKey: `zenith/ws_integration/${envClass}/terraform.tfstate` });
  return { graph, fragments, workspace };
}
