/**
 * One scenario per hypothesis rule, each built from hand-made port answers
 * against the same small graph. Each asserts the top hypothesis, that its
 * confidence comes from evidence that really exists, what is proposed, and
 * what is deliberately NOT proposed.
 */
import { describe, expect, it } from "vitest";
import { CapabilityRequestSchema } from "@/lib/capabilities/catalog";
import { investigate, type Investigation } from "@/lib/incidents";
import type { NormalizedEvent } from "@/lib/observability/types";
import { ADDR, ENV, NOW, PROJECT, WORKSPACE, buildGraph, change, driftFinding, driftReport, healthyWorld, log, makePorts, obs, rt, series, withCache, type World } from "./fixtures";
import type { ResourceGraph } from "@/lib/resources/types";

const env = { workspaceId: WORKSPACE, projectId: PROJECT, environmentId: ENV };
const go = (world: World, opts: { graph?: ResourceGraph; symptom?: string } = {}) =>
  investigate({ graph: opts.graph ?? buildGraph(), environment: env, symptom: opts.symptom }, makePorts(world));
const evidenceOf = (inv: Investigation, check: string, address?: string) => inv.evidence.find((e) => e.check === check && (address === undefined || e.address === address));
const hyp = (inv: Investigation, code: string) => inv.hypotheses.find((h) => h.code === code);
const capabilities = (inv: Investigation, code: string) => (hyp(inv, code)?.remediations ?? []).map((r) => r.request.capability);

describe("bad deploy", () => {
  function world(): World {
    const w = healthyWorld();
    w.changes = [change("deployment", 12, "release 1.5.0 (web)", "op_deploy_77")];
    w.runtimes[ADDR.web] = rt(ADDR.web, "degraded", { desired: 2, running: 1, pending: 1 }, ["deployment_failed", "task_stopped:EssentialContainerExited", "task_exit_code:1"]);
    w.runtimes[ADDR.lb] = rt(ADDR.lb, "degraded", { target_groups: 1, targets_healthy: 1, targets_unhealthy: 1 }, ["target_unhealthy:1"]);
    w.logs[ADDR.web] = [
      log(ADDR.web, "listening on port 3000", 25, "info"),
      log(ADDR.web, "GET /health 200 2ms", 15, "info"),
      ...[8, 7, 6, 5, 4, 3].map((m) => log(ADDR.web, `"GET /checkout HTTP/1.1" 500 12`, m, "error")),
    ];
    return w;
  }

  it("ranks bad_deploy first, citing the deployment, the failed rollout and errors that started after it", async () => {
    const inv = await go(world());
    const h = inv.hypotheses[0];
    expect(h.code).toBe("bad_deploy");
    expect(h.confidence).toBeGreaterThanOrEqual(0.8);
    expect(h.category).toBe("deployment");
    const cited = inv.evidence.filter((e) => h.supportingEvidence.includes(e.id)).map((e) => e.check);
    expect(cited).toEqual(expect.arrayContaining(["changes.recent", "changes.errors_after_deploy", "service.rollout"]));
    const after = evidenceOf(inv, "changes.errors_after_deploy")!;
    expect(after.outcome).toBe("fail");
    expect(after.data).toMatchObject({ before: 0, after: 6, newErrors: true, operationId: "op_deploy_77" });
  });

  it("proposes a rollback of exactly that deployment, scoped to the environment", async () => {
    const inv = await go(world());
    const r = hyp(inv, "bad_deploy")!.remediations;
    expect(r.map((x) => x.request.capability)).toEqual(["deployment.rollback"]);
    expect(r[0].request.scope).toEqual({ workspaceId: WORKSPACE, projectId: PROJECT, environmentId: ENV });
    expect(r[0].request.input).toEqual({ strategy: "previous_revision", operationId: "op_deploy_77" });
    expect(r[0].reversibility).toMatch(/does not undo database migrations/);
    expect(CapabilityRequestSchema.safeParse(r[0].request).success).toBe(true);
  });

  it("is contradicted when the same errors were already there before the deploy", async () => {
    const w = world();
    w.runtimes[ADDR.web] = rt(ADDR.web, "healthy", { desired: 2, running: 2 }, []);
    w.logs[ADDR.web] = [...[25, 24, 23, 22, 21, 20, 19, 18].map((m) => log(ADDR.web, `"GET /checkout HTTP/1.1" 500 12`, m)), ...[8, 7, 6, 5, 4, 3].map((m) => log(ADDR.web, `"GET /checkout HTTP/1.1" 500 12`, m))];
    const inv = await go(w);
    expect(evidenceOf(inv, "changes.errors_after_deploy")?.outcome).toBe("pass");
    expect(hyp(inv, "bad_deploy")).toBeUndefined();
  });

  it("does not call old errors new when the deploy is too close to the start of the log window", async () => {
    const w = world();
    w.changes = [change("deployment", 29, "release 1.5.0", "op_old")];
    const inv = await go(w);
    const e = evidenceOf(inv, "changes.errors_after_deploy")!;
    expect(e.outcome).toBe("unknown");
    expect(e.data.comparable).toBe(false);
  });

  it("a failed rollout with no recorded deployment is weaker than with one, and offers no rollback to a deploy it cannot name", async () => {
    const w = world();
    w.changes = [];
    const inv = await go(w);
    const h = hyp(inv, "bad_deploy");
    expect(h === undefined || h.confidence < 0.8).toBe(true);
    expect(capabilities(inv, "bad_deploy")).toEqual([]);
  });
});

describe("container crash: out of memory", () => {
  function world(): World {
    const w = healthyWorld();
    w.runtimes[ADDR.web] = rt(ADDR.web, "degraded", { desired: 2, running: 1, tasks_stopped_recent: 3 }, ["task_stopped:OutOfMemory", "task_exit_code:137"]);
    w.logs[ADDR.web] = [log(ADDR.web, "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", 4)];
    w.metrics[ADDR.web] = [series("cpu.utilization", [40, 42, 41], "percent", ADDR.web), series("memory.utilization", [95, 97, 98, 96, 99], "percent", ADDR.web)];
    return w;
  }

  it("ranks container_crash_oom first from the stop reason, the logs and memory pressure", async () => {
    const inv = await go(world());
    const h = inv.hypotheses[0];
    expect(h.code).toBe("container_crash_oom");
    expect(h.confidence).toBeGreaterThanOrEqual(0.8);
    expect(evidenceOf(inv, "service.stopped_tasks")?.data).toMatchObject({ oom: true, exitCodes: [137] });
    expect(evidenceOf(inv, "capacity.memory")?.outcome).toBe("fail");
    expect(hyp(inv, "capacity_saturation")).toBeUndefined(); // crashing is not saturation
  });

  it("proposes a manifest size change plus deploy, and a restart only as a temporary mitigation", async () => {
    const inv = await go(world());
    const r = hyp(inv, "container_crash_oom")!.remediations;
    expect(r.map((x) => x.request.capability)).toEqual(["deployment.deploy", "service.restart"]);
    expect(r[0].request.input).toMatchObject({ proposal: "increase_memory", service: ADDR.web, currentMemoryMb: 1024, suggestedMemoryMb: 2048 });
    expect(r[0].manualSteps?.[0]).toMatch(/larger size/);
    expect(r[1].request.scope.resourceId).toBe(ADDR.web);
    expect(r[1].reversibility).toMatch(/only clears memory for a while/);
    expect(r[1].risk).toBe("medium");
  });

  it("treats exit code 137 as memory pressure even without an OOM reason", async () => {
    const w = world();
    w.runtimes[ADDR.web] = rt(ADDR.web, "degraded", { desired: 2, running: 1 }, ["task_stopped:EssentialContainerExited", "task_exit_code:137"]);
    w.logs[ADDR.web] = [log(ADDR.web, "GET /health 200", 4, "info")];
    const inv = await go(w);
    expect(evidenceOf(inv, "service.stopped_tasks")?.data.oom).toBe(true);
    expect(inv.hypotheses[0].code).toBe("container_crash_oom");
  });
});

describe("image pull failure", () => {
  it("is found from the runtime signal, and proposes a rollback only when a deployment is on record", async () => {
    const w = healthyWorld();
    w.changes = [change("deployment", 6, "release 1.5.1", "op_9")];
    w.runtimes[ADDR.web] = rt(ADDR.web, "unhealthy", { desired: 2, running: 0, pending: 2 }, ["task_stopped:CannotPullContainerError", "deployment_failed", "no_running_tasks"]);
    w.logs[ADDR.web] = [];
    const inv = await go(w);
    const h = inv.hypotheses[0];
    expect(h.code).toBe("image_pull_failure");
    expect(h.confidence).toBeGreaterThanOrEqual(0.8);
    expect(capabilities(inv, "image_pull_failure")).toEqual(["deployment.rollback"]);
    expect(h.nextSteps?.[0]).toMatch(/image tag exists/);
  });

  it("is found from provider events alone, with no rollback when nothing was deployed", async () => {
    const w = healthyWorld();
    const event: NormalizedEvent = {
      timestamp: new Date(NOW.getTime() - 3 * 60_000).toISOString(),
      address: ADDR.web,
      provider: "aws",
      environmentId: ENV,
      severity: "error",
      type: "ecs.service.task_failed",
      message: "CannotPullContainerError: pull access denied for registry.example.com/shop/web, repository does not exist",
      native: {},
    };
    w.events = { [ADDR.web]: [event] };
    w.runtimes[ADDR.web] = rt(ADDR.web, "unhealthy", { desired: 2, running: 0 }, ["no_running_tasks"]);
    const inv = await go(w);
    expect(evidenceOf(inv, "service.image_pull")?.outcome).toBe("fail");
    expect(evidenceOf(inv, "service.image_pull")?.data).toMatchObject({ fromRuntime: false, fromText: true });
    expect(inv.hypotheses[0].code).toBe("image_pull_failure");
    expect(capabilities(inv, "image_pull_failure")).toEqual([]);
    expect(inv.notes?.join(" ")).not.toMatch(/Provider events were not searched/);
  });
});

describe("missing secret", () => {
  function world(): World {
    const w = healthyWorld();
    w.observations[ADDR.secret] = obs(ADDR.secret, "missing");
    w.runtimes[ADDR.web] = rt(ADDR.web, "unhealthy", { desired: 2, running: 0 }, ["task_stopped:TaskFailedToStart", "no_running_tasks"]);
    w.logs[ADDR.web] = [
      log(ADDR.web, "ResourceInitializationError: unable to pull secrets or registry auth: secretsmanager ResourceNotFoundException", 6),
      log(ADDR.web, "Error: Environment variable DATABASE_URL is not set", 5),
    ];
    return w;
  }

  it("ranks missing_secret first", async () => {
    const inv = await go(world());
    expect(inv.hypotheses[0].code).toBe("missing_secret");
    expect(inv.hypotheses[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(evidenceOf(inv, "secret.present")?.outcome).toBe("fail");
    expect(evidenceOf(inv, "secret.resolution_error")?.outcome).toBe("fail");
    expect(evidenceOf(inv, "logs.missing_env")?.data.envVars).toEqual(["DATABASE_URL"]);
  });

  it("asks a person for the value: secret.write names the reference and carries no value", async () => {
    const inv = await go(world());
    const r = hyp(inv, "missing_secret")!.remediations;
    expect(r).toHaveLength(1);
    expect(r[0].request.capability).toBe("secret.write");
    expect(r[0].humanInputRequired).toBe(true);
    expect(r[0].request.input).toEqual({ address: ADDR.secret, secretRef: "vault:db-url" });
    expect(Object.keys(r[0].request.input as object)).not.toContain("value");
    expect(r[0].manualSteps?.join(" ")).toMatch(/never reads, generates or displays/);
    expect(r[0].risk).toBe("high");
    expect(CapabilityRequestSchema.safeParse(r[0].request).success).toBe(true);
  });

  it("an env var that is not a secret reference is a follow-up for a person, not a secret.write", async () => {
    const w = healthyWorld();
    w.runtimes[ADDR.web] = rt(ADDR.web, "unhealthy", { desired: 2, running: 0 }, ["no_running_tasks"]);
    w.logs[ADDR.web] = [log(ADDR.web, "KeyError: 'STRIPE_PUBLIC_KEY'", 5)];
    const inv = await go(w);
    const h = hyp(inv, "missing_secret")!;
    expect(h.remediations).toEqual([]);
    expect(h.nextSteps?.join(" ")).toContain("STRIPE_PUBLIC_KEY");
  });
});

describe("IAM denied", () => {
  it("ranks iam_denied first and proposes restoring the drifted identity plus a reviewed grant", async () => {
    const w = healthyWorld();
    w.runtimes[ADDR.lb] = rt(ADDR.lb, "degraded", { target_groups: 1, targets_healthy: 1, targets_unhealthy: 1 }, ["target_unhealthy:1"]);
    w.logs[ADDR.web] = [1, 2, 3, 4].map((m) =>
      log(ADDR.web, "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/web-task/abc is not authorized to perform: secretsmanager:GetSecretValue on resource: vault", m)
    );
    w.drift = driftReport([driftFinding(ADDR.identity, "changed", { severity: "high", autoRepairEligible: false })]);
    const inv = await go(w);
    const h = inv.hypotheses[0];
    expect(h.code).toBe("iam_denied");
    expect(h.confidence).toBeGreaterThanOrEqual(0.75);
    expect(h.category).toBe("identity");
    expect(evidenceOf(inv, "identity.access_denied")?.data.actions).toEqual(["secretsmanager:GetSecretValue"]);
    // reported by the identity hop, not double counted at the application hop
    expect(evidenceOf(inv, "logs.iam_denied")).toBeUndefined();
    expect(h.remediations.map((r) => r.request.capability)).toEqual(["drift.repair", "identity.modify"]);
    const modify = h.remediations[1];
    expect(modify.risk).toBe("critical");
    expect(modify.humanInputRequired).toBe(true);
    expect(modify.request.input).toMatchObject({ deniedActions: ["secretsmanager:GetSecretValue"], reviewRequired: true });
  });
});

describe("TLS certificate", () => {
  it("flags a certificate expiring within 14 days, without inventing a remediation", async () => {
    const w = healthyWorld();
    w.observations[ADDR.tls] = obs(ADDR.tls, "present", { status: "ISSUED", notAfter: new Date(NOW.getTime() + 9 * 86_400_000).toISOString() });
    const inv = await go(w);
    const h = inv.hypotheses[0];
    expect(h.code).toBe("certificate_invalid");
    expect(evidenceOf(inv, "tls.certificate_expiry")?.outcome).toBe("fail");
    expect(evidenceOf(inv, "tls.certificate_expiry")?.finding).toMatch(/expires in 9 days/);
    expect(evidenceOf(inv, "tls.certificate_issued")?.outcome).toBe("pass");
    expect(h.remediations).toEqual([]);
    expect(h.nextSteps?.join(" ")).toMatch(/renew/);
  });

  it("exactly 14 days is not yet a warning; 13.9 is", async () => {
    const at = (days: number) => {
      const w = healthyWorld();
      w.observations[ADDR.tls] = obs(ADDR.tls, "present", { status: "ISSUED", notAfter: new Date(NOW.getTime() + days * 86_400_000).toISOString() });
      return go(w);
    };
    expect(evidenceOf(await at(14), "tls.certificate_expiry")?.outcome).toBe("pass");
    expect(evidenceOf(await at(13.9), "tls.certificate_expiry")?.outcome).toBe("fail");
  });

  it("an expired, unissued certificate is near-certain, and a failing TLS handshake from the prober agrees", async () => {
    const w = healthyWorld();
    w.observations[ADDR.tls] = obs(ADDR.tls, "present", { status: "EXPIRED", notAfter: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() });
    w.http = { "app.example.com": { error: "CERT_HAS_EXPIRED" } };
    const inv = await go(w);
    expect(inv.hypotheses[0].code).toBe("certificate_invalid");
    expect(inv.hypotheses[0].confidence).toBe(1);
    expect(evidenceOf(inv, "http.tls_handshake")?.address).toBe(ADDR.tls);
    expect(evidenceOf(inv, "tls.certificate_expiry")?.finding).toMatch(/expired 2 days ago/);
  });

  it("a pending certificate with manual DNS validation says who has to create the record", async () => {
    const g = buildGraph();
    g.nodes = g.nodes.map((n) => (n.address === ADDR.tls ? { ...n, spec: { ...n.spec, validation: "dns_manual" } } : n));
    const w = healthyWorld();
    w.observations[ADDR.tls] = obs(ADDR.tls, "present", { status: "PENDING_VALIDATION" });
    const inv = await go(w, { graph: g });
    const h = inv.hypotheses[0];
    expect(h.code).toBe("certificate_invalid");
    expect(h.nextSteps?.join(" ")).toMatch(/manual DNS validation/);
    expect(h.remediations).toEqual([]);
  });

  it("a certificate that is missing at the provider can be re-applied (managed) through drift.repair", async () => {
    const w = healthyWorld();
    w.observations[ADDR.tls] = obs(ADDR.tls, "missing");
    const inv = await go(w);
    expect(capabilities(inv, "certificate_invalid")).toEqual(["drift.repair"]);
  });
});

describe("database down", () => {
  function world(): World {
    const w = healthyWorld();
    w.runtimes[ADDR.db] = rt(ADDR.db, "unhealthy", {}, ["db_status:storage-full"]);
    w.runtimes[ADDR.lb] = rt(ADDR.lb, "unhealthy", { targets_healthy: 0, targets_unhealthy: 2 }, ["target_unhealthy:2"]);
    w.logs[ADDR.web] = [
      log(ADDR.web, "Error: connect ECONNREFUSED 10.0.3.15:5432", 4),
      log(ADDR.web, "FATAL: the database system is starting up", 3),
    ];
    return w;
  }

  it("ranks db_down first and never proposes restoring or deleting a database", async () => {
    const inv = await go(world());
    const h = inv.hypotheses[0];
    expect(h.code).toBe("db_down");
    expect(h.confidence).toBeGreaterThanOrEqual(0.8);
    expect(evidenceOf(inv, "db.available")?.data).toMatchObject({ health: "unhealthy", status: "storage-full" });
    expect(h.remediations).toEqual([]);
    expect(h.nextSteps?.join(" ")).toMatch(/human decision/);
    const everyCapability = inv.hypotheses.flatMap((x) => x.remediations.map((r) => r.request.capability));
    expect(everyCapability.filter((c) => /restore|delete|destroy/.test(c))).toEqual([]);
  });

  it("a database missing at the provider is db_down too", async () => {
    const w = healthyWorld();
    w.observations[ADDR.db] = obs(ADDR.db, "missing");
    w.runtimes[ADDR.db] = rt(ADDR.db, "unknown", {}, ["not_found"]);
    const inv = await go(w);
    expect(evidenceOf(inv, "db.exists")?.outcome).toBe("fail");
    expect(inv.hypotheses[0].code).toBe("db_down");
  });
});

describe("DNS", () => {
  it("a missing record, confirmed by the prober and the drift report, is dns_misconfigured with a repair", async () => {
    const w = healthyWorld();
    w.observations[ADDR.dns] = obs(ADDR.dns, "missing");
    w.drift = driftReport([driftFinding(ADDR.dns, "missing")]);
    w.http = { "app.example.com": { error: "getaddrinfo ENOTFOUND app.example.com" } };
    const inv = await go(w);
    const h = inv.hypotheses[0];
    expect(h.code).toBe("dns_misconfigured");
    expect(h.confidence).toBeGreaterThanOrEqual(0.8);
    expect(evidenceOf(inv, "http.dns_resolution")?.address).toBe(ADDR.dns);
    expect(h.remediations).toHaveLength(1);
    expect(h.remediations[0].request).toMatchObject({ capability: "drift.repair", scope: { resourceId: ADDR.dns } });
    expect(h.remediations[0].blastRadius).toBe("low");
  });

  it("a record pointing somewhere else names the attribute that differs", async () => {
    const w = healthyWorld();
    w.observations[ADDR.dns] = obs(ADDR.dns, "present", { target: "old-lb.example.net", type: "A" });
    const inv = await go(w);
    const e = evidenceOf(inv, "dns.record_target")!;
    expect(e.outcome).toBe("fail");
    expect(e.finding).toContain('"old-lb.example.net"');
    expect(inv.hypotheses[0].code).toBe("dns_misconfigured");
  });

  it("a prober that resolves and answers contradicts a DNS diagnosis", async () => {
    const w = healthyWorld();
    w.observations[ADDR.dns] = obs(ADDR.dns, "present", { target: "old-lb.example.net", type: "A" });
    w.http = { "app.example.com": { status: 200, latencyMs: 30 } };
    const inv = await go(w);
    const h = hyp(inv, "dns_misconfigured");
    expect(h?.confidence ?? 0).toBeLessThan(0.3);
  });
});

describe("capacity saturation", () => {
  it("fires on high CPU and memory with every task running, and proposes scaling out", async () => {
    const w = healthyWorld();
    w.metrics[ADDR.web] = [series("cpu.utilization", [93, 95, 96, 94, 97], "percent", ADDR.web), series("memory.utilization", [88, 90, 91, 92, 93], "percent", ADDR.web)];
    w.metrics[ADDR.lb] = [series("http.5xx.rate", [0, 0, 2, 5, 7, 9], "count/min", ADDR.lb)];
    const inv = await go(w);
    const h = inv.hypotheses[0];
    expect(h.code).toBe("capacity_saturation");
    expect(h.confidence).toBeGreaterThanOrEqual(0.8);
    expect(h.remediations.map((r) => r.request.capability)).toEqual(["service.scale"]);
    expect(h.remediations[0].request.input).toEqual({ address: ADDR.web, replicas: 3 });
    expect(h.remediations[0].risk).toBe("medium");
  });

  it("does not guess a percentage from a unit it does not understand", async () => {
    const w = healthyWorld();
    w.metrics[ADDR.web] = [series("cpu.utilization", [9, 9, 9], "millicores", ADDR.web), series("memory.utilization", [0.95, 0.96, 0.97], "ratio", ADDR.web)];
    const inv = await go(w);
    expect(evidenceOf(inv, "capacity.cpu")?.outcome).toBe("unknown");
    expect(evidenceOf(inv, "capacity.memory")?.outcome).toBe("fail"); // a ratio is understood
  });
});

describe("generic load balancer rule", () => {
  it("unhealthy targets alone is capped below a specific cause, and proposes nothing", async () => {
    const w = healthyWorld();
    w.runtimes[ADDR.lb] = rt(ADDR.lb, "unhealthy", { targets_healthy: 0, targets_unhealthy: 2 }, ["target_unhealthy:2", "target_reason:Target.ResponseCodeMismatch:2"]);
    const inv = await go(w);
    expect(inv.hypotheses).toHaveLength(1);
    const h = inv.hypotheses[0];
    expect(h.code).toBe("lb_no_healthy_targets");
    expect(h.confidence).toBeLessThanOrEqual(0.5);
    expect(h.remediations).toEqual([]);
    expect(evidenceOf(inv, "lb.target_health")?.data.reasons).toEqual([{ code: "Target.ResponseCodeMismatch", count: 2 }]);
  });
});

describe("cache behind its own security group", () => {
  it("names the cache, not the database, when the cache ingress rule is missing", async () => {
    const w = healthyWorld();
    w.observations["firewall/web-to-cache"] = obs("firewall/web-to-cache", "missing");
    w.observations["redis/cache"] = obs("redis/cache", "present");
    w.runtimes["redis/cache"] = rt("redis/cache", "healthy");
    w.logs[ADDR.web] = [log(ADDR.web, "Error: connect ETIMEDOUT 10.0.4.9:6379", 3), log(ADDR.web, "Error: connect ETIMEDOUT 10.0.4.9:6379", 2)];
    w.runtimes[ADDR.lb] = rt(ADDR.lb, "unhealthy", { targets_healthy: 0, targets_unhealthy: 2 }, ["target_unhealthy:2"]);
    w.drift = driftReport([driftFinding("firewall/web-to-cache", "missing")]);
    const inv = await go(w, { graph: withCache(buildGraph()) });
    expect(inv.hypotheses[0].code).toBe("cache_unreachable_security_group");
    expect(inv.hypotheses[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(hyp(inv, "db_unreachable_security_group")).toBeUndefined();
    expect(inv.hypotheses[0].remediations[0].request.scope.resourceId).toBe("firewall/web-to-cache");
  });

  it("attributes timeouts to a dependency by the port the log names, not by guessing", async () => {
    const w = healthyWorld();
    w.logs[ADDR.web] = [log(ADDR.web, "connect ETIMEDOUT 10.9.9.9:9999", 3), log(ADDR.web, "connect ETIMEDOUT 10.0.3.15:5432", 2)];
    const inv = await go(w);
    const other = evidenceOf(inv, "logs.connect_timeout")!;
    expect(other.data.ports).toEqual([9999]);
    expect(other.data.dependency).toBeUndefined();
    const db = evidenceOf(inv, "logs.db_connect_timeout")!;
    expect(db.data).toMatchObject({ ports: [5432], dependency: ADDR.db, dependencyClass: "database" });
  });
});

describe("the other ingress rules on the path", () => {
  it("a missing load balancer to service rule is service_unreachable_security_group, repaired through drift.repair", async () => {
    const w = healthyWorld();
    w.observations[ADDR.fwLbWeb] = obs(ADDR.fwLbWeb, "missing");
    w.runtimes[ADDR.lb] = rt(ADDR.lb, "unhealthy", { targets_healthy: 0, targets_unhealthy: 2 }, ["target_unhealthy:2", "target_reason:Target.Timeout:2"]);
    w.drift = driftReport([driftFinding(ADDR.fwLbWeb, "missing")]);
    const inv = await go(w);
    expect(inv.hypotheses[0].code).toBe("service_unreachable_security_group");
    expect(inv.hypotheses[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(inv.hypotheses.map((h) => h.code)).toContain("lb_no_healthy_targets"); // the generic symptom, ranked below
    const r = inv.hypotheses[0].remediations;
    expect(r.map((x) => x.request.capability)).toEqual(["drift.repair"]);
    expect(r[0].request.scope.resourceId).toBe(ADDR.fwLbWeb);
    expect(r[0].expectedEffect).toContain(`from ${ADDR.lb} to ${ADDR.web}`);
  });

  it("a missing public ingress rule is public_ingress_blocked, and its passing sibling (:80) does not clear it", async () => {
    const w = healthyWorld();
    w.observations[ADDR.fw443] = obs(ADDR.fw443, "missing");
    w.drift = driftReport([driftFinding(ADDR.fw443, "missing")]);
    w.http = { "app.example.com": { error: "connect ETIMEDOUT 203.0.113.10:443" } };
    const inv = await go(w);
    expect(evidenceOf(inv, "firewall.ingress_rule", ADDR.fw80)?.outcome).toBe("pass");
    expect(inv.hypotheses[0].code).toBe("public_ingress_blocked");
    expect(inv.hypotheses[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(inv.hypotheses[0].basis?.map((b) => b.clause)).not.toContain("rule_present");
    expect(inv.hypotheses[0].remediations[0].request.scope.resourceId).toBe(ADDR.fw443);
    expect(inv.hypotheses[0].remediations[0].expectedEffect).toContain("from 0.0.0.0/0");
  });

  it("a public endpoint that answers contradicts a blocked-ingress diagnosis", async () => {
    const w = healthyWorld();
    w.observations[ADDR.fw443] = obs(ADDR.fw443, "missing");
    w.http = { "app.example.com": { status: 200, latencyMs: 30 } };
    const inv = await go(w);
    const h = inv.hypotheses.find((x) => x.code === "public_ingress_blocked");
    expect(h?.confidence ?? 0).toBeLessThan(0.3);
  });

  it("a passing rule does clear the diagnosis when no sibling of its class is failing", async () => {
    const w = healthyWorld();
    w.observations[ADDR.fwLbWeb] = obs(ADDR.fwLbWeb, "present", { port: 3000, protocol: "tcp" });
    w.runtimes[ADDR.lb] = rt(ADDR.lb, "unhealthy", { targets_healthy: 0, targets_unhealthy: 2 }, ["target_unhealthy:2"]);
    const inv = await go(w);
    expect(inv.hypotheses.map((h) => h.code)).toEqual(["lb_no_healthy_targets"]);
  });
});
