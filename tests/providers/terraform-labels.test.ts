/**
 * Terraform block labels must be unique, because duplicate labels are a *parse*
 * error — an export that emits them cannot even `terraform plan`, so the bundle
 * Orrery hands you is worthless at the moment you need it.
 *
 * Sanitising is lossy: `tf()` maps every character outside [A-Za-z0-9_] to `_`,
 * so "api.v1" and "api-v1" both become "api_v1", and the paths "/x.y" and
 * "/x-y" both become "_x_y". Two things went wrong with that:
 *
 *  - the listener-rule loop had no uniqueness guard at all, and emitted two
 *    `aws_lb_listener_rule` blocks with one label;
 *  - the target-group loop "deduplicated" by skipping the collision, which
 *    parsed fine but silently pointed both routes at the *first* service.
 *
 * The second is the worse bug: a green export that sends traffic to the wrong
 * container. These tests pin both.
 */
import { describe, expect, it } from "vitest";
import type { Environment, Manifest } from "@/lib/domain/types";
import type { ExportFile } from "@/lib/providers/types";
import { terraformFiles } from "@/lib/providers/aws/terraform";

const environment: Environment = {
  id: "env-staging",
  projectId: "proj-atlas",
  name: "staging",
  class: "staging",
  connectionId: "conn-aws",
  region: "us-west-2",
  policies: { approvalRequired: false, allowStatefulDeletion: false },
  baseDomain: "atlas.orrery.test",
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** Two services and two routes chosen so every pair collides after `tf()`. */
function collidingManifest(): Manifest {
  const svc = (id: string, name: string, port: number) => ({
    id,
    name,
    kind: "web" as const,
    source: { type: "image" as const, image: `ghcr.io/acme/${id}:1` },
    size: "small" as const,
    replicas: 1,
    port,
    healthPath: "/healthz",
    env: [],
    ownership: "managed" as const,
  });
  return {
    version: 1,
    // "api.v1" and "api-v1" both sanitise to "api_v1".
    services: [svc("svc-a", "api.v1", 3000), svc("svc-b", "api-v1", 4000)],
    resources: [],
    // "/x.y" and "/x-y" both sanitise to "_x_y", on the same host. Both pass
    // the tightened Route schema — this is a collision, not invalid input.
    routes: [
      { id: "rt-a", host: "app.example.com", pathPrefix: "/x.y", tls: true, managedDns: true },
      { id: "rt-b", host: "app.example.com", pathPrefix: "/x-y", tls: true, managedDns: true },
    ],
    bindings: [
      { id: "bind-a", from: "rt-a", to: "svc-a", capability: "http" },
      { id: "bind-b", from: "rt-b", to: "svc-b", capability: "http" },
    ],
    jobs: [],
  } as unknown as Manifest;
}

const alb = (files: ExportFile[]): string => files.find((f) => f.path.endsWith("alb.tf"))?.content ?? "";

/** Every `resource "type" "label"` in the bundle, as `type.label`. */
function declaredAddresses(hcl: string): string[] {
  return [...hcl.matchAll(/^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/gm)].map((m) => `${m[1]}.${m[2]}`);
}

describe("terraform block labels are unique", () => {
  it("emits no duplicate resource address anywhere in the bundle", () => {
    const hcl = terraformFiles(environment, collidingManifest())
      .filter((f) => f.path.endsWith(".tf"))
      .map((f) => f.content)
      .join("\n");
    const addresses = declaredAddresses(hcl);
    const duplicates = addresses.filter((a, i) => addresses.indexOf(a) !== i);
    expect(duplicates).toEqual([]);
  });

  it("gives colliding services their own target group instead of dropping one", () => {
    const hcl = alb(terraformFiles(environment, collidingManifest()));
    const groups = declaredAddresses(hcl).filter((a) => a.startsWith("aws_lb_target_group."));
    // Two distinct services means two target groups, whatever their names sanitise to.
    expect(groups).toHaveLength(2);
    expect(new Set(groups).size).toBe(2);
    // Each keeps its own port, which is how you can tell they were not merged.
    expect(hcl).toContain("port        = 3000");
    expect(hcl).toContain("port        = 4000");
  });

  it("gives colliding routes their own listener rule", () => {
    const hcl = alb(terraformFiles(environment, collidingManifest()));
    const rules = declaredAddresses(hcl).filter((a) => a.startsWith("aws_lb_listener_rule."));
    expect(rules).toHaveLength(2);
    expect(new Set(rules).size).toBe(2);
  });

  it("points each listener rule at its own service's target group", () => {
    const hcl = alb(terraformFiles(environment, collidingManifest()));
    const targets = [...hcl.matchAll(/target_group_arn = (aws_lb_target_group\.[A-Za-z0-9_]+)\.arn/g)].map(
      (m) => m[1]
    );
    // The bug this replaces: both rules forwarded to one group.
    expect(new Set(targets).size).toBe(2);
    // And each target actually exists.
    const declared = new Set(declaredAddresses(hcl));
    for (const t of targets) expect(declared.has(t)).toBe(true);
  });

  it("still emits one target group when several routes share one service", () => {
    const m = collidingManifest();
    // Both routes now point at the same service: that is real deduplication.
    (m.bindings as { to: string }[])[1].to = "svc-a";
    const hcl = alb(terraformFiles(environment, m));
    expect(declaredAddresses(hcl).filter((a) => a.startsWith("aws_lb_target_group."))).toHaveLength(1);
    expect(declaredAddresses(hcl).filter((a) => a.startsWith("aws_lb_listener_rule."))).toHaveLength(2);
  });

  it("is deterministic across repeated exports", () => {
    const once = alb(terraformFiles(environment, collidingManifest()));
    const twice = alb(terraformFiles(environment, collidingManifest()));
    expect(once).toBe(twice);
  });
});
