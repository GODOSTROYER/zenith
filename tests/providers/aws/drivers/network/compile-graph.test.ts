/**
 * The whole fixture graph through the network drivers: determinism, workspace
 * assembly, cross-node reference resolution, the security-group contract, IAM
 * and secret hygiene, and (gated) `tofu validate` against the real aws 6.66.0
 * provider schema.
 *
 *   ZENITH_TEST_TOFU_NETWORK=1 npx vitest run tests/providers/aws/drivers/network/compile-graph.test.ts
 *
 * The stand-in fragments for `aws:ecs_service` / `aws:rds_instance` (owned by
 * other workstreams) come from fixtures/env.ts; they contribute a placeholder
 * resource and the node's security group through the shared contract, nothing
 * more.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { SECURITY_GROUP_KINDS } from "@/lib/providers/aws/drivers/shared";
import type { ResourceGraph } from "@/lib/resources/types";
import { resolveTofuBinary } from "@/lib/tofu/binary";
import { TofuRunner } from "@/lib/tofu/runner";
import { assemble, compileGraph, mainOf } from "../fixtures/env";
import { CERT, FIXTURE_TAGS, LB, NETWORK, ZONE, fixtureGraph, nodeOf } from "../fixtures/graph";

type Body = Record<string, unknown>;
const graph = fixtureGraph();
const fragments = compileGraph(graph);
const ws = assemble(graph, fragments);
const main = mainOf(ws);
const resources = main.resource ?? {};

const allResources = (): [string, string, Body][] => Object.entries(resources).flatMap(([t, named]) => Object.entries(named).map(([n, b]) => [t, n, b] as [string, string, Body]));
const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      strings(x, out);
    }
  }
  return out;
};

describe("fixture graph: assembly and determinism", () => {
  it("assembles into a pinned aws workspace with every node's addresses defined and owned once", () => {
    expect(ws.files.map((f) => f.path)).toEqual(["backend.tf.json", "main.tf.json", "providers.tf.json", "versions.tf.json"]);
    for (const [nodeAddress, list] of Object.entries(ws.addressMap)) {
      for (const a of list) {
        const m = /^(data\.)?([a-z0-9_]+)\.([A-Za-z0-9_-]+)$/.exec(a)!;
        const bucket = m[1] ? main.data : main.resource;
        expect(bucket?.[m[2]]?.[m[3]], `${nodeAddress}: ${a}`).toBeDefined();
      }
    }
    expect(Object.keys(ws.addressMap).sort()).toEqual(graph.nodes.map((n) => n.address).sort());
  });

  it("compiling twice gives byte-identical workspaces (same digests)", () => {
    const again = assemble(graph, compileGraph(fixtureGraph()));
    expect(again.configDigest).toBe(ws.configDigest);
    expect(again.files.map((f) => f.content)).toEqual(ws.files.map((f) => f.content));
  });

  it("node order in the graph does not reach the output", () => {
    const shuffled = fixtureGraph();
    shuffled.nodes.reverse();
    shuffled.nodes.forEach((n) => n.dependsOn.reverse());
    expect(assemble(shuffled, compileGraph(shuffled)).configDigest).toBe(ws.configDigest);
  });

  it("every label is a plain [a-z0-9_] identifier, unique per type", () => {
    for (const [t, n] of allResources()) expect(n, `${t}.${n}`).toMatch(/^[a-z_][a-z0-9_]*$/);
  });
});

describe("fixture graph: references", () => {
  const defined = new Set<string>([...allResources().map(([t, n]) => `${t}.${n}`), ...Object.entries(main.data ?? {}).flatMap(([t, named]) => Object.keys(named).map((n) => `data.${t}.${n}`))]);
  const locals = new Set(Object.keys(main.locals ?? {}));
  const everything = strings({ resource: main.resource, data: main.data, locals: main.locals, output: main.output });

  it("every ${local.ref_…} a driver asks ctx.ref for is published by the node that owns it", () => {
    const used = new Set(everything.flatMap((s) => [...s.matchAll(/\$\{local\.([a-z0-9_]+)\}/g)].map((m) => m[1])));
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) expect(locals.has(name), name).toBe(true);
  });

  it("every tofu traversal points at a defined resource or data source", () => {
    const refs = new Set(everything.flatMap((s) => [...s.matchAll(/\b((?:data\.)?aws_[a-z0-9_]+\.[a-z0-9_]+)\b/g)].map((m) => m[1])));
    expect(refs.size).toBeGreaterThan(20);
    for (const r of refs) expect(defined.has(r), r).toBe(true);
  });

  it("no node hard-codes another node's tofu label: cross-node values always go through published locals", () => {
    // Each node's own resources may reference each other; references that leave the node must be locals.
    for (const [nodeAddress, fragment] of fragments) {
      const own = new Set(fragment.addresses);
      const text = strings({ resource: fragment.resource, output: fragment.output });
      for (const s of text) {
        for (const m of s.matchAll(/\b((?:data\.)?aws_[a-z0-9_]+\.[a-z0-9_]+)\b/g)) {
          const inSelf = own.has(m[1]) || [...own].some((a) => a.startsWith(`${m[1]}`));
          expect(inSelf, `${nodeAddress} references ${m[1]} which it does not own`).toBe(true);
        }
      }
    }
  });
});

describe("fixture graph: security groups", () => {
  const sgNodes = graph.nodes.filter((n) => (SECURITY_GROUP_KINDS as readonly string[]).includes(n.kind) && n.ownership === "managed");
  const groups = Object.entries(resources.aws_security_group ?? {});

  it("exactly one group per VPC-attached node, created by that node's own fragment, tagged with the owner", () => {
    expect(sgNodes.map((n) => n.address).sort()).toEqual(["container_service/api", "container_service/web", "load_balancer/public", "postgres/db"]);
    expect(groups).toHaveLength(sgNodes.length);
    for (const n of sgNodes) {
      const frag = fragments.get(n.address) as TofuFragment;
      const owned = Object.keys(frag.resource?.aws_security_group ?? {});
      expect(owned, n.address).toHaveLength(1);
      expect((frag.resource!.aws_security_group[owned[0]].tags as Record<string, string>)["zenith:resource"]).toBe(n.address);
    }
    for (const n of graph.nodes.filter((x) => x.kind === "firewall")) expect(fragments.get(n.address)!.resource?.aws_security_group).toBeUndefined();
  });

  it("groups carry no inline rules; every rule is a standalone rule resource attached to an existing group", () => {
    for (const [, body] of groups) {
      expect(body).not.toHaveProperty("ingress");
      expect(body).not.toHaveProperty("egress");
    }
    const sgIds = new Set(Object.values(main.locals ?? {}).filter((v) => typeof v === "string" && /^\$\{aws_security_group\./.test(v as string)));
    for (const t of ["aws_vpc_security_group_ingress_rule", "aws_vpc_security_group_egress_rule"]) {
      for (const [name, body] of Object.entries(resources[t] ?? {})) {
        expect(body.security_group_id, `${t}.${name}`).toMatch(/^\$\{(local\.ref_[a-z0-9_]+__security_group_id|aws_security_group\.[a-z0-9_]+\.id)\}$/);
        const localName = /local\.(ref_[a-z0-9_]+__security_group_id)/.exec(body.security_group_id as string)?.[1];
        if (localName) expect(main.locals![localName], localName).toBeDefined();
      }
    }
    expect(sgIds.size).toBe(4);
  });

  it("the only rule open to a CIDR is the public web rule on the load balancer, tcp/80 and tcp/443", () => {
    const open = Object.entries(resources.aws_vpc_security_group_ingress_rule ?? {}).filter(([, b]) => "cidr_ipv4" in b);
    expect(open.map(([n, b]) => [n, b.from_port, b.cidr_ipv4, b.security_group_id]).sort()).toEqual([
      ["firewall_internet_to_lb_443", 443, "0.0.0.0/0", "${local.ref_load_balancer_public__security_group_id}"],
      ["firewall_internet_to_lb_80", 80, "0.0.0.0/0", "${local.ref_load_balancer_public__security_group_id}"],
    ]);
  });

  it("egress is minimal: workloads 443 + their targets, the load balancer only its targets, the database none", () => {
    const egress = Object.entries(resources.aws_vpc_security_group_egress_rule ?? {}).map(([, b]) => b as Body);
    const of = (sgLocal: string) => egress.filter((b) => b.security_group_id === `\${local.ref_${sgLocal}__security_group_id}` || b.security_group_id === `\${aws_security_group.${sgLocal}_sg.id}`);
    const summary = (xs: Body[]) => xs.map((b) => `${b.from_port}:${b.cidr_ipv4 ?? "sg"}`).sort();
    expect(summary(of("container_service_web"))).toEqual(["443:0.0.0.0/0", "5432:sg"]);
    expect(summary(of("container_service_api"))).toEqual(["443:0.0.0.0/0", "5432:sg"]);
    expect(summary(of("load_balancer_public"))).toEqual(["3000:sg", "8080:sg"]);
    expect(of("postgres_db")).toEqual([]);
    // no rule anywhere allows all protocols or all ports
    for (const b of [...egress, ...Object.values(resources.aws_vpc_security_group_ingress_rule ?? {})]) {
      expect(b.ip_protocol).toBe("tcp");
      expect(typeof b.from_port).toBe("number");
      expect(b.from_port).toBe(b.to_port);
    }
  });

  it("the referenced zone contributes only a data source", () => {
    const f = fragments.get(ZONE)!;
    expect(f.resource).toBeUndefined();
    expect(Object.keys(f.data ?? {})).toEqual(["aws_route53_zone"]);
  });
});

describe("fixture graph: hygiene", () => {
  it("no wildcard IAM: every policy lists explicit actions on explicit resources, trust policies name a service", () => {
    const docs: { role: string; doc: { Statement: { Effect: string; Action: string | string[]; Resource?: string | string[]; Principal?: unknown }[] } }[] = [];
    for (const [t, n, b] of allResources()) {
      if (t === "aws_iam_role") docs.push({ role: n, doc: JSON.parse(b.assume_role_policy as string) });
      if (t === "aws_iam_role_policy") docs.push({ role: n, doc: JSON.parse(b.policy as string) });
    }
    expect(docs.length).toBeGreaterThanOrEqual(2);
    for (const { role, doc } of docs) {
      for (const s of doc.Statement) {
        const actions = ([] as string[]).concat(s.Action);
        expect(actions.every((a) => !a.includes("*")), `${role} ${actions}`).toBe(true);
        if (s.Resource !== undefined) expect(([] as string[]).concat(s.Resource).every((r) => r !== "*"), role).toBe(true);
        if (s.Principal !== undefined) expect(JSON.stringify(s.Principal)).not.toContain('"*"');
      }
    }
    expect(Object.keys(resources).filter((t) => t === "aws_iam_policy" || t === "aws_iam_user")).toEqual([]);
    for (const [, , b] of allResources().filter(([t]) => t === "aws_iam_role")) expect(b.permissions_boundary).toContain("policy/ZenithWorkloadBoundary");
  });

  it("every taggable resource carries the Zenith tags and the address of the node that owns it", () => {
    const untaggable = new Set(["aws_route", "aws_route_table_association", "aws_iam_role_policy", "aws_lb_listener_certificate", "aws_acm_certificate_validation", "aws_route53_record", "terraform_data"]);
    const owner = new Map<string, string>();
    for (const [node, list] of Object.entries(ws.addressMap)) for (const a of list) owner.set(a, node);
    let checked = 0;
    for (const [t, n, b] of allResources()) {
      if (untaggable.has(t)) continue;
      const tags = b.tags as Record<string, string> | undefined;
      expect(tags, `${t}.${n}`).toBeDefined();
      for (const [k, v] of Object.entries(FIXTURE_TAGS)) expect(tags![k], `${t}.${n} ${k}`).toBe(v);
      expect(tags!["zenith:resource"], `${t}.${n}`).toBe(owner.get(`${t}.${n}`));
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("CANARY: no secret value or secret reference of the workloads reaches any compiled file", () => {
    const canary = "CANARY-sk_live_4242424242424242";
    const g = fixtureGraph();
    for (const address of ["container_service/web", "container_service/api"]) {
      const n = nodeOf(g, address);
      n.spec = { ...n.spec, env: [{ key: "STRIPE_KEY", value: canary }, { key: "SESSION_SECRET", secretRef: "vault:proj/web/SESSION_SECRET" }] };
    }
    const fw = nodeOf(g, "firewall/web-to-db");
    fw.spec = { ...fw.spec, description: "web reaches db" };
    const w = assemble(g, compileGraph(g));
    const all = w.files.map((f) => f.content).join("\n");
    expect(all).not.toContain(canary);
    expect(all).not.toContain("vault:proj");
    expect(all).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(all).not.toMatch(/secret_access_key|aws_secret|password|private_key/i);
    // outputs are never sensitive-by-accident: there are none in the automatic fixture
    expect(main.output).toBeUndefined();
  });

  it("load balancer deletion protection follows the production tag; everything else stays destroyable", () => {
    expect(resources.aws_lb.load_balancer_public.enable_deletion_protection).toBe(true);
    for (const [t, , b] of allResources()) if (t !== "aws_lb") expect(b.enable_deletion_protection, t).toBeUndefined();
  });
});

/** Graph shapes beyond the base fixture; each must compile, assemble and (gated) validate. */
const variants: [string, (g: ResourceGraph) => void][] = [
  ["single NAT", (g) => void (nodeOf(g, NETWORK).spec = { cidr: "10.0.0.0/16", zones: 2, egress: { natGateways: "single" } })],
  ["no NAT", (g) => void (nodeOf(g, NETWORK).spec = { cidr: "10.0.0.0/16", zones: 2, egress: { natGateways: "none" } })],
  ["manual certificate", (g) => void (nodeOf(g, CERT).spec = { domain: "app.acme.io", validation: "dns_manual" })],
  [
    "second TLS host with its own certificate",
    (g) => {
      g.nodes.push({ ...nodeOf(g, CERT), address: "tls_certificate/www.acme.io", spec: { domain: "www.acme.io", validation: "dns_automatic", zone: ZONE } });
      const lb = nodeOf(g, LB);
      lb.dependsOn = [...lb.dependsOn, "tls_certificate/www.acme.io"];
      lb.spec = { ...lb.spec, routes: [...(lb.spec.routes as object[]), { host: "www.acme.io", pathPrefix: "/", tls: true, target: "container_service/web", port: 3000 }] };
    },
  ],
];

describe("graph variants", () => {
  for (const [name, patch] of variants) {
    it(`${name}: compiles and assembles`, () => {
      const g = fixtureGraph();
      patch(g);
      const w = assemble(g, compileGraph(g));
      expect(w.files).toHaveLength(4);
    });
  }

  it("a manual certificate adds an output with the records to create and no validation resources", () => {
    const g = fixtureGraph();
    variants[2][1](g);
    const m = mainOf(assemble(g, compileGraph(g)));
    expect(Object.keys(m.output ?? {})).toHaveLength(1);
    expect(m.resource!.aws_acm_certificate_validation).toBeUndefined();
    expect(Object.keys(m.resource!.aws_route53_record)).toHaveLength(2); // the two alias records only
  });
});

/* ------------------------------ real tofu validate ------------------------- */

function tofuOnPath(): boolean {
  try {
    return spawnSync(resolveTofuBinary(), ["version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const enabled = process.env.ZENITH_TEST_TOFU_NETWORK === "1" && tofuOnPath();

async function validate(w: ReturnType<typeof assemble>) {
  const runner = new TofuRunner({ limits: { timeoutMs: 600_000 } });
  return runner.run(w, {}, async (run) => {
    await run.init({ backend: false });
    return run.validate();
  });
}

describe.skipIf(!enabled)("tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1)", () => {
  it(
    "the assembled fixture workspace validates",
    async () => {
      const v = await validate(ws);
      expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(v.valid).toBe(true);
    },
    900_000
  );

  it(
    "the validator has teeth: an unknown argument in a compiled resource makes the same workspace invalid",
    async () => {
      const broken = new Map(fragments);
      const f = JSON.parse(JSON.stringify(fragments.get(NETWORK))) as TofuFragment;
      (f.resource!.aws_vpc.network_main as Body).not_a_real_argument = true;
      broken.set(NETWORK, f);
      const v = await validate(assemble(graph, broken));
      expect(v.valid).toBe(false);
      expect(v.diagnostics.some((d) => d.severity === "error" && /not_a_real_argument/.test(`${d.summary} ${d.detail ?? ""}`))).toBe(true);
    },
    900_000
  );

  for (const [name, patch] of variants) {
    it(
      `variant validates: ${name}`,
      async () => {
        const g = fixtureGraph();
        patch(g);
        const v = await validate(assemble(g, compileGraph(g)));
        expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        expect(v.valid).toBe(true);
      },
      900_000
    );
  }
});
