/**
 * Compile tests for `aws:ecs_service` and `aws:ecs_scheduled_task`: structure,
 * determinism, secrets handling, IAM least privilege, image handling,
 * Fargate rounding, load-balancer wiring and the ways a bad graph is refused.
 */
import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import { DriverCompileError, refLocalName } from "@/lib/providers/aws/drivers/compute/support/aws-shared";
import { ecsScheduledTaskDriver } from "@/lib/providers/aws/drivers/compute/ecs-scheduled-task";
import { ecsServiceDriver } from "@/lib/providers/aws/drivers/compute/ecs-service";
import { BOOTSTRAP_TAG, imagePointerName } from "@/lib/providers/aws/drivers/compute/ecs-task";
import { SECRET_ADDRESS, SECRET_CANARY, buildFixture, mkCompileContext, mkNode, type GraphOptions } from "./fixtures";

type Body = Record<string, unknown>;
const res = (f: TofuFragment, type: string, label: string): Body => (f.resource as Record<string, Record<string, Body>>)[type][label];
const compileService = (opts: GraphOptions = {}, mutate?: (nodes: Map<string, ResourceNode>) => void) => {
  const fx = buildFixture(opts);
  mutate?.(fx.byAddress);
  const node = fx.byAddress.get("container_service/web")!;
  return { fx, node, fragment: ecsServiceDriver.compile!(node, mkCompileContext(fx.byAddress)) };
};
const containers = (f: TofuFragment): Body[] => JSON.parse(res(f, "aws_ecs_task_definition", "container_service_web").container_definitions as string);

/** Every IAM policy document a fragment defines, with its owner label. */
function policies(f: TofuFragment): { label: string; statements: Body[] }[] {
  const out: { label: string; statements: Body[] }[] = [];
  for (const [label, body] of Object.entries(f.resource?.aws_iam_role_policy ?? {})) {
    const doc = JSON.parse((body as Body).policy as string);
    out.push({ label, statements: doc.Statement });
  }
  return out;
}
const asList = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [v as string]);

describe("aws:ecs_service compile", () => {
  it("emits the whole workload, with the service as the primary address and every address defined", () => {
    const { fragment } = compileService();
    expect(fragment.addresses[0]).toBe("aws_ecs_service.container_service_web");
    const defined = new Set<string>();
    for (const [t, named] of Object.entries(fragment.resource ?? {})) for (const n of Object.keys(named)) defined.add(`${t}.${n}`);
    for (const [t, named] of Object.entries(fragment.data ?? {})) for (const n of Object.keys(named)) defined.add(`data.${t}.${n}`);
    expect([...defined].sort()).toEqual([...fragment.addresses].sort());
    expect(fragment.addresses).toEqual(
      expect.arrayContaining([
        "aws_ecs_cluster.container_service_web",
        "aws_ecs_task_definition.container_service_web",
        "aws_iam_role.container_service_web_exec",
        "aws_iam_role_policy.container_service_web_exec",
        "aws_security_group.container_service_web_sg",
        "aws_vpc_security_group_egress_rule.container_service_web_sg_https",
      ])
    );
  });

  it("runs on Fargate in the private subnets with no public IP and a circuit breaker", () => {
    const { fragment } = compileService({ replicas: 3 });
    const svc = res(fragment, "aws_ecs_service", "container_service_web");
    expect(svc).toMatchObject({
      launch_type: "FARGATE",
      desired_count: 3,
      deployment_minimum_healthy_percent: 100,
      deployment_maximum_percent: 200,
      deployment_circuit_breaker: [{ enable: true, rollback: true }],
      enable_execute_command: false,
      wait_for_steady_state: false,
      propagate_tags: "SERVICE",
      enable_ecs_managed_tags: true,
    });
    const nc = (svc.network_configuration as Body[])[0];
    expect(nc.assign_public_ip).toBe(false);
    expect(nc.subnets).toEqual([`\${local.${refLocalName("subnet/private-a", "id")}}`, `\${local.${refLocalName("subnet/private-b", "id")}}`]);
    expect(nc.security_groups).toEqual(["${aws_security_group.container_service_web_sg.id}"]);
    // never a public subnet
    expect(JSON.stringify(nc.subnets)).not.toContain("public");
    expect(svc.depends_on).toEqual(["aws_iam_role_policy.container_service_web_exec", "aws_vpc_security_group_egress_rule.container_service_web_sg_https"]);
  });

  it("owns its security group through the shared contract: no inline rules, HTTPS egress only, published as security_group_id", () => {
    const { fragment } = compileService();
    const sg = res(fragment, "aws_security_group", "container_service_web_sg");
    expect(sg).not.toHaveProperty("ingress");
    expect(sg).not.toHaveProperty("egress");
    expect(sg.vpc_id).toBe(`\${local.${refLocalName("network/main", "id")}}`);
    expect(res(fragment, "aws_vpc_security_group_egress_rule", "container_service_web_sg_https")).toMatchObject({ from_port: 443, to_port: 443, cidr_ipv4: "0.0.0.0/0" });
    expect(fragment.locals).toHaveProperty(refLocalName("container_service/web", "security_group_id"), "${aws_security_group.container_service_web_sg.id}");
    expect(fragment.locals).toHaveProperty(refLocalName("container_service/web", "arn"), "${aws_ecs_service.container_service_web.arn}");
  });

  it("gives every node its own cluster with Container Insights and tags everything taggable", () => {
    const { fragment } = compileService();
    const cluster = res(fragment, "aws_ecs_cluster", "container_service_web");
    expect(cluster.name).toBe("zn-acme-web");
    expect(cluster.setting).toEqual([{ name: "containerInsights", value: "enabled" }]);
    for (const [type, label] of [
      ["aws_ecs_cluster", "container_service_web"],
      ["aws_ecs_service", "container_service_web"],
      ["aws_ecs_task_definition", "container_service_web"],
      ["aws_iam_role", "container_service_web_exec"],
      ["aws_security_group", "container_service_web_sg"],
    ] as const) {
      expect(res(fragment, type, label).tags, `${type}.${label}`).toMatchObject({
        "zenith:workspace": "ws_1",
        "zenith:environment": "env_1",
        "zenith:managed": "true",
        "zenith:resource": "container_service/web",
      });
    }
  });

  it("rounds cpu/memory up to a Fargate size and puts the rounded numbers in the task definition", () => {
    const { fragment, node } = compileService({ vcpu: 0.25, memoryMb: 256 });
    const td = res(fragment, "aws_ecs_task_definition", "container_service_web");
    expect([td.cpu, td.memory]).toEqual(["256", "512"]);
    expect(ecsServiceDriver.expectedAttributes!(node)).toMatchObject({ cpu: 256, memoryMb: 512, replicas: 2, launchType: "FARGATE", assignPublicIp: false, port: 8080 });
    const small = compileService();
    expect([res(small.fragment, "aws_ecs_task_definition", "container_service_web").cpu, res(small.fragment, "aws_ecs_task_definition", "container_service_web").memory]).toEqual(["512", "1024"]);
  });

  it("describes the container: port, plain env, secret references, awslogs, writable root fs, no health check", () => {
    const { fragment } = compileService();
    const [c] = containers(fragment);
    expect(containers(fragment)).toHaveLength(1);
    expect(c.name).toBe("web");
    expect(c.essential).toBe(true);
    expect(c.portMappings).toEqual([{ containerPort: 8080, protocol: "tcp" }]);
    expect(c.environment).toEqual([
      { name: "LOG_LEVEL", value: "info" },
      { name: "PORT", value: "8080" },
    ]);
    expect(c.secrets).toEqual([{ name: "DATABASE_URL", valueFrom: `\${local.${refLocalName(SECRET_ADDRESS, "arn")}}` }]);
    expect(c.readonlyRootFilesystem).toBe(false);
    expect(c).not.toHaveProperty("healthCheck");
    expect(c.logConfiguration).toEqual({
      logDriver: "awslogs",
      options: { "awslogs-group": `\${local.${refLocalName("log_group/web", "name")}}`, "awslogs-region": "eu-west-1", "awslogs-stream-prefix": "ecs" },
    });
    const td = res(fragment, "aws_ecs_task_definition", "container_service_web");
    expect(td).toMatchObject({ network_mode: "awsvpc", requires_compatibilities: ["FARGATE"], runtime_platform: [{ operating_system_family: "LINUX", cpu_architecture: "X86_64" }] });
    expect(td.task_role_arn).toBe(`\${local.${refLocalName("identity/web", "arn")}}`);
    expect(td.execution_role_arn).toBe("${aws_iam_role.container_service_web_exec.arn}");
    expect(td.lifecycle).toEqual({ create_before_destroy: true });
  });

  it("keeps an explicit PORT and refuses duplicate or malformed env", () => {
    const { fragment } = compileService({ env: [{ key: "PORT", value: "9999" }] });
    expect((containers(fragment)[0].environment as Body[]).filter((e) => e.name === "PORT")).toEqual([{ name: "PORT", value: "9999" }]);
    expect(() => compileService({ env: [{ key: "A", value: "1" }, { key: "A", value: "2" }], withSecret: false })).toThrow(/declared twice/);
    expect(() => compileService({ env: [{ key: "bad key", value: "1" }], withSecret: false })).toThrow(/valid identifier/);
    expect(() => compileService({ env: [{ key: "BIG", value: "x".repeat(5000) }], withSecret: false })).toThrow(/at most 4096/);
  });

  describe("secrets", () => {
    it("never puts a secret value or the secret reference text in the fragment: only ARN references", () => {
      const { fragment } = compileService({ env: [{ key: "DATABASE_URL", secretRef: `vault:${SECRET_CANARY}` }, { key: "LOG_LEVEL", value: "info" }] });
      const all = JSON.stringify(fragment);
      expect(all).not.toContain(SECRET_CANARY);
      expect(containers(fragment)[0].secrets).toEqual([{ name: "DATABASE_URL", valueFrom: `\${local.${refLocalName(SECRET_ADDRESS, "arn")}}` }]);
      // the environment array carries no entry for the secret key
      expect((containers(fragment)[0].environment as Body[]).map((e) => e.name)).not.toContain("DATABASE_URL");
    });

    it("lets the execution role read exactly the referenced secrets", () => {
      const { fragment } = compileService();
      const st = policies(fragment).find((p) => p.label === "container_service_web_exec")!.statements.find((s) => s.Sid === "ReadReferencedSecrets")!;
      expect(st).toMatchObject({ Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: `\${local.${refLocalName(SECRET_ADDRESS, "arn")}}` });
    });

    it("has no secrets statement and no secrets array entries without secret references", () => {
      const { fragment } = compileService({ withSecret: false });
      expect(containers(fragment)[0].secrets).toEqual([]);
      expect(policies(fragment)[0].statements.map((s) => s.Sid)).not.toContain("ReadReferencedSecrets");
    });

    it("refuses a secret reference its identity has no grant for (it would have no permission to read it)", () => {
      const fx = buildFixture();
      const identity = fx.byAddress.get("identity/web")!;
      identity.spec = { ...identity.spec, grants: (identity.spec.grants as { via: string[] }[]).filter((g) => !g.via.includes("env:DATABASE_URL")) };
      expect(() => ecsServiceDriver.compile!(fx.service, mkCompileContext(fx.byAddress))).toThrow(/no grant naming a secret node/);
    });

    it("refuses a secret whose grant points at something that is not a secret node", () => {
      const fx = buildFixture();
      fx.byAddress.delete(SECRET_ADDRESS);
      expect(() => ecsServiceDriver.compile!(fx.service, mkCompileContext(fx.byAddress))).toThrow(DriverCompileError);
    });
  });

  describe("template injection", () => {
    it("escapes `${…}` and `%{…}` in env values so tofu renders them literally", () => {
      const evil = '${file("/proc/self/environ")} and %{ if true }x%{ endif }';
      const { fragment } = compileService({ env: [{ key: "NOTE", value: evil }], withSecret: false });
      const text = res(fragment, "aws_ecs_task_definition", "container_service_web").container_definitions as string;
      expect(text).toContain('$${file(\\"/proc/self/environ\\")}');
      expect(text).toContain("%%{ if true }");
      // after stripping legitimate interpolations and the escapes, no live opener remains
      const live = text.replace(/\$\$\{/g, "").replace(/%%\{/g, "").replace(/\$\{(?:local|data|aws_)[A-Za-z0-9_.-]*\}/g, "");
      expect(live).not.toMatch(/\$\{|%\{/);
    });

    it("escapes a hostile tag value exactly once, in my resources and in the shared security group alike", () => {
      const fx = buildFixture();
      const ctx = mkCompileContext(fx.byAddress, { tags: { "zenith:workspace": "ws_1", "zenith:environment": "env_1", "zenith:managed": "true", "team": "${file(\"x\")}" } });
      const f = ecsServiceDriver.compile!(fx.service, ctx);
      expect(res(f, "aws_ecs_cluster", "container_service_web").tags).toMatchObject({ team: '$${file("x")}' });
      expect(res(f, "aws_security_group", "container_service_web_sg").tags).toMatchObject({ team: '$${file("x")}' });
      expect(JSON.stringify(f)).not.toContain("$$${");
    });

    it("refuses node addresses and image references that are not plain text", () => {
      const fx = buildFixture({ artifact: { type: "image", ref: "nginx:${var.x}" }, withSecret: false });
      expect(() => ecsServiceDriver.compile!(fx.service, mkCompileContext(fx.byAddress))).toThrow(/image reference contains characters/);
      const bad = mkNode("container_service/we${b}", "container_service", "aws:ecs_service", {});
      expect(() => ecsServiceDriver.compile!(bad, mkCompileContext(new Map()))).toThrow(/characters that are not allowed/);
    });
  });

  describe("execution role IAM", () => {
    const exec = (f: TofuFragment) => policies(f).find((p) => p.label === "container_service_web_exec")!.statements;

    it("has no wildcard action and only ONE bare `*` resource: ecr:GetAuthorizationToken, which AWS defines no resource for", () => {
      const { fragment } = compileService();
      const star: string[] = [];
      for (const st of exec(fragment)) {
        for (const a of asList(st.Action)) expect(a).not.toContain("*");
        if (asList(st.Resource).includes("*")) {
          expect(asList(st.Resource)).toEqual(["*"]);
          star.push(...asList(st.Action));
        }
      }
      expect(star).toEqual(["ecr:GetAuthorizationToken"]);
    });

    it("limits any other wildcard to the trailing log-stream suffix of this container's streams", () => {
      const { fragment } = compileService();
      const wild = exec(fragment).flatMap((st) => asList(st.Resource).map((r) => ({ r, actions: asList(st.Action) }))).filter(({ r }) => r.includes("*") && r !== "*");
      expect(wild).toHaveLength(1);
      expect(wild[0].actions).toEqual(["logs:CreateLogStream", "logs:PutLogEvents"]);
      expect(wild[0].r).toMatch(/:log-group:\$\{local\.[^}]+\}:log-stream:ecs\/web\/\*$/);
    });

    it("pulls from exactly the workload's registry and nothing else in ECR", () => {
      const { fragment } = compileService();
      const pull = exec(fragment).find((s) => s.Sid === "PullImage")!;
      expect(pull.Resource).toBe(`\${local.${refLocalName("container_registry/web", "arn")}}`);
      expect(asList(pull.Action).sort()).toEqual(["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]);
      for (const st of exec(fragment)) for (const a of asList(st.Action).filter((x) => x.startsWith("ecr:"))) expect(a).not.toMatch(/Put|Upload|Delete|Create/);
    });

    it("carries the permissions boundary and trusts only ecs-tasks", () => {
      const { fragment } = compileService();
      const role = res(fragment, "aws_iam_role", "container_service_web_exec");
      expect(role.permissions_boundary).toMatch(/:policy\/ZenithWorkloadBoundary$/);
      expect(JSON.parse(role.assume_role_policy as string).Statement).toEqual([{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }]);
    });
  });

  describe("images", () => {
    it("a pinned public image is written literally and needs no ECR access or image pointer", () => {
      const { fragment, node } = compileService({ artifact: { type: "image", ref: "ghcr.io/acme/web:2.0.1" }, withSecret: false });
      expect(containers(fragment)[0].image).toBe("ghcr.io/acme/web:2.0.1");
      expect(fragment.resource).not.toHaveProperty("aws_ssm_parameter");
      expect(fragment.data).not.toHaveProperty("aws_ssm_parameter");
      expect(policies(fragment)[0].statements.map((s) => s.Sid)).toEqual(["WriteLogs"]);
      expect(ecsServiceDriver.expectedAttributes!(node).image).toBe("ghcr.io/acme/web:2.0.1");
    });

    it("a pinned image in this account's ECR gets pull permission on exactly that repository", () => {
      const ref = `123456789012.dkr.ecr.eu-west-1.amazonaws.com/acme/web@sha256:${"c".repeat(64)}`;
      const { fragment } = compileService({ artifact: { type: "image", ref }, withSecret: false });
      const sids = policies(fragment)[0].statements.map((s) => s.Sid);
      expect(sids).toEqual(["RegistryToken", "PullImage", "WriteLogs"]);
      const pull = policies(fragment)[0].statements.find((s) => s.Sid === "PullImage")!;
      expect(pull.Resource).toBe("arn:${data.aws_partition.container_service_web.partition}:ecr:eu-west-1:123456789012:repository/acme/web");
    });

    it("a built image is read from the image pointer, created once and never overwritten by tofu", () => {
      const { fragment, node } = compileService();
      const pointer = res(fragment, "aws_ssm_parameter", "container_service_web_image");
      expect(pointer).toMatchObject({ name: imagePointerName("env_1", "container_service/web"), type: "String", lifecycle: { ignore_changes: ["insecure_value"] } });
      expect(pointer.insecure_value).toBe(`\${local.${refLocalName("container_registry/web", "repository_url")}}:${BOOTSTRAP_TAG}`);
      expect(pointer).not.toHaveProperty("value");
      const read = (fragment.data as Record<string, Record<string, Body>>).aws_ssm_parameter.container_service_web_image;
      expect(read).toMatchObject({ with_decryption: false, depends_on: ["aws_ssm_parameter.container_service_web_image"] });
      expect(containers(fragment)[0].image).toBe("${data.aws_ssm_parameter.container_service_web_image.insecure_value}");
      // a built image is not a desired attribute: there is no digest at compile time
      expect(ecsServiceDriver.expectedAttributes!(node)).not.toHaveProperty("image");
    });

    it("refuses blueprint sources and a built workload whose registry is not in the graph", () => {
      expect(() => compileService({ artifact: { type: "blueprint", blueprint: "hello" } })).toThrow(/runs only on the sandbox provider/);
      expect(() => compileService({}, (m) => m.delete("container_registry/web"))).toThrow(/is not a container_registry node/);
      expect(() => compileService({ artifact: { type: "built", pipeline: "build_pipeline/web" } })).toThrow(/needs a container_registry/);
    });
  });

  describe("load balancer", () => {
    it("attaches the target group the load balancer published for this service, with a health grace period", () => {
      const { fragment } = compileService();
      const svc = res(fragment, "aws_ecs_service", "container_service_web");
      expect(svc.load_balancer).toEqual([{ target_group_arn: `\${local.${refLocalName("load_balancer/public", "target_group_arn:container_service/web")}}`, container_name: "web", container_port: 8080 }]);
      expect(svc.health_check_grace_period_seconds).toBe(60);
    });

    it("has no load_balancer block and no grace period when nothing routes to it", () => {
      const { fragment } = compileService({ withLb: false });
      const svc = res(fragment, "aws_ecs_service", "container_service_web");
      expect(svc).not.toHaveProperty("load_balancer");
      expect(svc).not.toHaveProperty("health_check_grace_period_seconds");
    });

    it("emits one block per routed port and maps every port into the container", () => {
      const { fragment } = compileService({}, (m) => {
        const lb = m.get("load_balancer/public")!;
        const routes = (lb.spec.routes as { target: string; port?: number; host: string; pathPrefix: string; tls: boolean }[]).slice();
        lb.spec = { ...lb.spec, routes: [...routes, { host: "admin.example.com", pathPrefix: "/", tls: false, target: "container_service/web", port: 9090 }] };
      });
      const svc = res(fragment, "aws_ecs_service", "container_service_web");
      const blocks = svc.load_balancer as Body[];
      expect(blocks.map((b) => b.container_port)).toEqual([8080, 9090]);
      expect(blocks.map((b) => b.target_group_arn)).toEqual([
        `\${local.${refLocalName("load_balancer/public", "target_group_arn:container_service/web:8080")}}`,
        `\${local.${refLocalName("load_balancer/public", "target_group_arn:container_service/web:9090")}}`,
      ]);
      expect(containers(fragment)[0].portMappings).toEqual([
        { containerPort: 8080, protocol: "tcp" },
        { containerPort: 9090, protocol: "tcp" },
      ]);
    });

    it("refuses a routed service with no port", () => {
      expect(() =>
        compileService({ port: null }, (m) => {
          const lb = m.get("load_balancer/public")!;
          lb.spec = { ...lb.spec, routes: [{ host: "app.example.com", pathPrefix: "/", tls: false, target: "container_service/web" }] };
        })
      ).toThrow(/declares no port/);
    });
  });

  describe("refusals", () => {
    it.each([
      ["no log group", (m: Map<string, ResourceNode>) => m.delete("log_group/web"), /needs a log_group node/],
      ["no private subnet", (m: Map<string, ResourceNode>) => { m.delete("subnet/private-a"); m.delete("subnet/private-b"); }, /at least one private subnet/],
    ])("%s", (_name, mutate, message) => {
      expect(() => compileService({}, mutate)).toThrow(message);
      expect(() => compileService({}, mutate)).toThrow(DriverCompileError);
    });

    it.each([-1, 1.5, 5000, "2"])("replicas %j", (replicas) => {
      const fx = buildFixture();
      fx.service.spec = { ...fx.service.spec, replicas };
      expect(() => ecsServiceDriver.compile!(fx.service, mkCompileContext(fx.byAddress))).toThrow(/replicas must be an integer/);
    });

    it("a size no Fargate task offers", () => {
      expect(() => compileService({ vcpu: 64 })).toThrow(/No Fargate task size/);
    });

    it("a non-AWS node", () => {
      const fx = buildFixture();
      fx.service.provider = "gcp";
      expect(() => ecsServiceDriver.compile!(fx.service, mkCompileContext(fx.byAddress))).toThrow(/cannot compile a gcp node/);
    });

    it("compiles a referenced or external service to nothing (it may only ever be data)", () => {
      for (const ownership of ["referenced", "external"] as const) {
        const fx = buildFixture();
        fx.service.ownership = ownership;
        expect(ecsServiceDriver.compile!(fx.service, mkCompileContext(fx.byAddress))).toEqual({ addresses: [] });
      }
    });
  });

  it("is deterministic and independent of dependsOn order", () => {
    const a = compileService();
    const b = compileService();
    expect(JSON.stringify(b.fragment)).toBe(JSON.stringify(a.fragment));
    const shuffled = compileService({}, (m) => {
      const n = m.get("container_service/web")!;
      n.dependsOn = [...n.dependsOn].reverse();
    });
    expect(JSON.stringify(shuffled.fragment)).toBe(JSON.stringify(a.fragment));
  });

  it("declares honest evidence: contract for everything, no claim of live verification", () => {
    const caps = ecsServiceDriver.capabilities;
    expect(Object.values(caps.evidence).every((v) => v === "contract")).toBe(true);
    expect(caps.operations.sort()).toEqual(["deployment.deploy", "service.restart", "service.scale"]);
    for (const op of caps.operations) expect(caps.evidence[op]).toBe("contract");
  });

  it("expectedAttributes names exactly what observe reads (port only with a port; image only when pinned)", () => {
    const fx = buildFixture({ port: null, artifact: { type: "image", ref: "nginx:1.27" }, withLb: false, withSecret: false });
    expect(Object.keys(ecsServiceDriver.expectedAttributes!(fx.service)).sort()).toEqual(["assignPublicIp", "cpu", "image", "launchType", "memoryMb", "replicas"]);
  });
});

describe("aws:ecs_scheduled_task compile", () => {
  const compileJob = (mutate?: (n: ResourceNode) => void, nodes?: (m: Map<string, ResourceNode>) => void) => {
    const fx = buildFixture();
    mutate?.(fx.job);
    nodes?.(fx.byAddress);
    return { fx, fragment: ecsScheduledTaskDriver.compile!(fx.job, mkCompileContext(fx.byAddress)) };
  };

  it("schedules the task with the translated cron, in the private subnets, with no public IP", () => {
    const { fragment } = compileJob();
    expect(fragment.addresses[0]).toBe("aws_cloudwatch_event_rule.scheduled_job_nightly");
    const rule = res(fragment, "aws_cloudwatch_event_rule", "scheduled_job_nightly");
    expect(rule).toMatchObject({ schedule_expression: "cron(0 2 ? * 2-6 *)", state: "ENABLED", name: "zn-acme-nightly" });
    expect(rule.description).toContain("0 2 * * 1-5");
    const target = res(fragment, "aws_cloudwatch_event_target", "scheduled_job_nightly");
    const ecs = (target.ecs_target as Body[])[0];
    expect(ecs).toMatchObject({ task_count: 1, launch_type: "FARGATE", task_definition_arn: "${aws_ecs_task_definition.scheduled_job_nightly.arn}" });
    expect((ecs.network_configuration as Body[])[0]).toMatchObject({ assign_public_ip: false, security_groups: ["${aws_security_group.scheduled_job_nightly_sg.id}"] });
    expect(target.arn).toBe("${aws_ecs_cluster.scheduled_job_nightly.arn}");
    expect(target.retry_policy).toEqual([{ maximum_retry_attempts: 2, maximum_event_age_in_seconds: 3600 }]);
    // nothing in the job runs a service
    expect(fragment.resource).not.toHaveProperty("aws_ecs_service");
  });

  it("the events role can run exactly this task definition in exactly this cluster and pass exactly the two task roles", () => {
    const { fragment } = compileJob();
    const events = policies(fragment).find((p) => p.label === "scheduled_job_nightly_events")!.statements;
    const run = events.find((s) => s.Sid === "RunThisTask")!;
    expect(run).toMatchObject({ Action: "ecs:RunTask", Resource: "${aws_ecs_task_definition.scheduled_job_nightly.arn}", Condition: { ArnEquals: { "ecs:cluster": "${aws_ecs_cluster.scheduled_job_nightly.arn}" } } });
    const pass = events.find((s) => s.Sid === "PassTaskRoles")!;
    expect(pass.Action).toBe("iam:PassRole");
    expect(pass.Resource).toEqual(["${aws_iam_role.scheduled_job_nightly_exec.arn}", `\${local.${refLocalName("identity/nightly", "arn")}}`]);
    expect(pass.Condition).toEqual({ StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } });
    for (const st of events) {
      for (const a of asList(st.Action)) expect(a).not.toContain("*");
      for (const r of asList(st.Resource)) expect(r).not.toContain("*");
    }
    const role = res(fragment, "aws_iam_role", "scheduled_job_nightly_events");
    expect(JSON.parse(role.assume_role_policy as string).Statement[0].Principal).toEqual({ Service: "events.amazonaws.com" });
    expect(role.permissions_boundary).toMatch(/ZenithWorkloadBoundary$/);
  });

  it("a public image job has an execution role that can only write logs, and no wildcard resource at all except the log-stream suffix", () => {
    const { fragment } = compileJob();
    const exec = policies(fragment).find((p) => p.label === "scheduled_job_nightly_exec")!.statements;
    expect(exec.map((s) => s.Sid)).toEqual(["WriteLogs"]);
    expect(asList(exec[0].Resource)[0]).toMatch(/:log-stream:ecs\/nightly\/\*$/);
  });

  it("rounds the job's size like a service (0.25 vCPU / 256 MB → 256 / 512)", () => {
    const { fragment, fx } = compileJob();
    const td = res(fragment, "aws_ecs_task_definition", "scheduled_job_nightly");
    expect([td.cpu, td.memory]).toEqual(["256", "512"]);
    expect(ecsScheduledTaskDriver.expectedAttributes!(fx.job)).toEqual({ cpu: 256, memoryMb: 512, image: "ghcr.io/acme/job:1.4.2" });
    expect((JSON.parse(td.container_definitions as string)[0] as Body).image).toBe("ghcr.io/acme/job:1.4.2");
  });

  it("a job with no schedule compiles to its task definition only", () => {
    const { fragment } = compileJob((n) => {
      n.spec = { ...n.spec, schedule: undefined };
    });
    expect(fragment.addresses[0]).toBe("aws_ecs_task_definition.scheduled_job_nightly");
    expect(fragment.resource).not.toHaveProperty("aws_cloudwatch_event_rule");
    expect(fragment.resource).not.toHaveProperty("aws_cloudwatch_event_target");
  });

  it.each(["0 0 1 * 1", "not a cron", "@reboot", "0 0 * * *; drop", "rate(5 minutes)"])("refuses schedule %j", (schedule) => {
    expect(() =>
      compileJob((n) => {
        n.spec = { ...n.spec, schedule };
      })
    ).toThrow(DriverCompileError);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(compileJob().fragment)).toBe(JSON.stringify(compileJob().fragment));
  });

  it("declares contract evidence and no operations", () => {
    expect(ecsScheduledTaskDriver.capabilities.operations).toEqual([]);
    expect(Object.values(ecsScheduledTaskDriver.capabilities.evidence).every((v) => v === "contract")).toBe(true);
  });
});

