import { afterEach, describe, expect, it } from "vitest";
import type { ResourceDriver } from "@/lib/drivers/types";
import type { AzureSession } from "@/lib/credentials/types";
import type { ResourceNode } from "@/lib/resources/types";
import { AZURE_DRIVERS } from "@/lib/providers/azure/drivers";
import { boundNative, redactDeep } from "@/lib/providers/azure/kit";
import { driverContext, ENV_ID, fakeArm, fakeEntra, mkNode, sampleGraph, sessionFor, SUB, type FakeArm } from "./_helpers";
import { buildWorld, RG, type Doc, type World } from "./_world";

const open: FakeArm[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const nodes = sampleGraph();
const node = (a: string) => nodes.find((n) => n.address === a)!;
const driverOf = (n: ResourceNode) => AZURE_DRIVERS.find((d) => d.nativeType === n.nativeType)! as ResourceDriver<AzureSession>;

async function setup(world: World = buildWorld(nodes)) {
  const arm = await fakeArm([world.route()], fakeEntra());
  open.push(arm);
  const session = await sessionFor(arm);
  const ctx = driverContext(session) as never;
  return { world, arm, session, ctx };
}

const known = (o: { attributes: Record<string, { state: string }> }, k: string) => o.attributes[k]?.state === "known";

describe("every driver reads a consistent subscription cleanly", () => {
  const observable = nodes.filter((n) => driverOf(n).observe);

  it.each(observable.map((n) => n.address))("%s: present, every expected attribute read and equal, verify passes or names what it cannot check", async (address) => {
    const { ctx, arm } = await setup();
    const n = node(address);
    const d = driverOf(n);
    const obs = await d.observe!(ctx, n);
    expect(obs.presence, obs.error).toBe("present");
    expect(obs.source).toBe(d.id);
    expect(obs.simulated).toBe(false);
    expect(obs.externalId).toBeDefined();

    // expectedAttributes names exactly the attributes observe reads
    const expected = d.expectedAttributes!(n);
    expect(Object.keys(obs.attributes).sort()).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) expect(known(obs, k), `${address}.${k}`).toBe(true);

    const runtime = d.runtime ? await d.runtime(ctx, n) : undefined;
    const v = await d.verify!(ctx, n, obs, runtime);
    const failed = v.checks.filter((c) => c.passed === false);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    // the only acceptable non-pass is an explicitly unverifiable check (registry scanning)
    if (address === "container_registry/web") expect(v.status).toBe("unknown");
    else expect(v.status, JSON.stringify(v.checks)).toBe("passed");
    expect(v.simulated).toBe(false);

    // observe/runtime/verify are read-only and every call carried an api-version and a bearer
    for (const r of arm.requests.filter((x) => x.pathname.startsWith("/subscriptions"))) {
      expect(r.method).toBe("GET");
      expect(r.query.get("api-version")).toBeTruthy();
      expect(r.authorization).toMatch(/^Bearer /);
    }
  });

  it("native bags are bounded (≤ 4 KiB) and never carry secret-shaped keys or values", async () => {
    const { ctx } = await setup();
    for (const n of observable) {
      const obs = await driverOf(n).observe!(ctx, n);
      if (!obs.native) continue;
      const text = JSON.stringify(obs.native);
      expect(Buffer.byteLength(text), n.address).toBeLessThanOrEqual(4096);
      expect(text).not.toMatch(/AccountKey=|SharedAccessKey=|Bearer |eyJ[A-Za-z0-9_-]{5,}\./);
    }
  });

  it("only the drivers that run something have a runtime; capabilities say so, with contract evidence only", () => {
    for (const d of AZURE_DRIVERS) {
      expect(d.capabilities.runtime).toBe(Boolean(d.runtime));
      expect(d.capabilities.compile).toBe(true);
      for (const [op, level] of Object.entries(d.capabilities.evidence)) expect(level, `${d.id}.${op}`).toBe("contract");
      expect(d.id).toMatch(/^azure\.[a-z_]+@1$/);
      expect(d.provider).toBe("azure");
    }
    expect(AZURE_DRIVERS.filter((d) => d.runtime).map((d) => d.nativeType).sort()).toEqual([
      "azure:application_gateway", "azure:container_app", "azure:container_app_job", "azure:postgresql_flexible_server", "azure:redis_cache", "azure:service_bus_queue", "azure:service_bus_topic",
    ]);
  });
});

describe("presence: present / missing / inaccessible / unknown", () => {
  const web = node("container_service/web");
  const d = driverOf(web);

  it("404 on the object itself → missing, with every attribute not_applicable (nothing guessed)", async () => {
    const { ctx, world } = await setup();
    world.docs.clear();
    const obs = await d.observe!(ctx, web, `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/gone`);
    expect(obs.presence).toBe("missing");
    for (const a of Object.values(obs.attributes)) expect(a).toMatchObject({ state: "unknown", reason: "not_applicable" });
  });

  it("no tagged match → missing", async () => {
    const { ctx, world } = await setup();
    world.tagged.length = 0;
    expect((await d.observe!(ctx, web)).presence).toBe("missing");
  });

  it("403 → inaccessible with access_denied, never 'missing'", async () => {
    const { ctx, world } = await setup();
    world.searchFailure = { status: 403, body: { error: { code: "AuthorizationFailed", message: "The client does not have authorization to perform action" } } };
    const obs = await d.observe!(ctx, web);
    expect(obs.presence).toBe("inaccessible");
    expect(obs.error).toMatch(/403.*AuthorizationFailed/);
    for (const a of Object.values(obs.attributes)) expect(a).toMatchObject({ state: "unknown", reason: "access_denied" });
  });

  it("401 is also inaccessible; 429 is unknown with the throttling detail; 500 is unknown", async () => {
    const { ctx, world } = await setup();
    world.searchFailure = { status: 401, body: { error: { code: "InvalidAuthenticationToken", message: "expired" } } };
    expect((await d.observe!(ctx, web)).presence).toBe("inaccessible");
    world.searchFailure = { status: 429, headers: { "retry-after": "7" }, body: { error: { code: "TooManyRequests", message: "slow down" } } };
    const throttled = await d.observe!(ctx, web);
    expect(throttled.presence).toBe("unknown");
    expect(throttled.error).toMatch(/429/);
    expect(throttled.error).toContain("TooManyRequests");
    world.searchFailure = { status: 500, body: "<html>boom</html>" };
    const server = await d.observe!(ctx, web);
    expect(server.presence).toBe("unknown");
    for (const a of Object.values(server.attributes)) expect(a).toMatchObject({ state: "unknown", reason: "error" });
  });

  it("a GET that fails after the tag search hit is classified the same way", async () => {
    const { ctx, world } = await setup();
    const id = world.tagged.find((t) => t.tags["zenith:resource"] === "container_service/web")!.id;
    world.fail(id, { status: 403 });
    expect((await d.observe!(ctx, web)).presence).toBe("inaccessible");
    world.fail(id, { status: 404 });
    expect((await d.observe!(ctx, web)).presence).toBe("missing");
    world.fail(id, { status: 429, headers: { "retry-after": "1" } });
    expect((await d.observe!(ctx, web)).presence).toBe("unknown");
  });

  it("finds by Zenith tags only: same address in another environment, or without the managed tag, is not a match", async () => {
    const { ctx, world } = await setup();
    for (const t of world.tagged) if (t.tags["zenith:resource"] === "container_service/web") t.tags["zenith:environment"] = "env_other";
    expect((await d.observe!(ctx, web)).presence).toBe("missing");
  });

  it("two tagged candidates are ambiguous, never picked", async () => {
    const { ctx, world } = await setup();
    const t = world.tagged.find((x) => x.tags["zenith:resource"] === "container_service/web")!;
    world.tagged.push({ ...t, id: t.id.replace("zn-k3x9q2-web", "zn-k3x9q2-web2"), name: "zn-k3x9q2-web2" });
    const obs = await d.observe!(ctx, web);
    expect(obs.presence).toBe("unknown");
    expect(obs.error).toMatch(/ambiguous/);
  });

  it("an externalId outside this subscription or of another type is refused before any request", async () => {
    const { ctx, arm } = await setup();
    const before = arm.requests.length;
    const wrongSub = "/subscriptions/99999999-9999-9999-9999-999999999999/resourceGroups/x/providers/Microsoft.App/containerApps/web";
    const wrongType = `/subscriptions/${SUB}/resourceGroups/x/providers/Microsoft.Cache/redis/web`;
    for (const id of [wrongSub, wrongType, "not-an-id", "/subscriptions/x/../y"]) {
      const obs = await d.observe!(ctx, web, id);
      expect(obs.presence).toBe("unknown");
    }
    expect(arm.requests.length).toBe(before);
  });

  it("an aborted operation reports unknown instead of throwing", async () => {
    const { session } = await setup();
    const ac = new AbortController();
    ac.abort();
    const obs = await d.observe!(driverContext(session, { signal: ac.signal }) as never, web);
    expect(obs.presence).toBe("unknown");
    expect(obs.error).toMatch(/abort/i);
  });

  it("an environment id that differs from the tags in the world finds nothing", async () => {
    const { session } = await setup();
    const ctx = driverContext(session, { environmentId: "env_else", tags: { "zenith:environment": "env_else" } }) as never;
    expect((await d.observe!(ctx, web)).presence).toBe("missing");
  });
});

describe("partial and malformed data is unknown, not guessed", () => {
  it("missing properties become not_inspected; an unparsable value is unknown, the rest is still read", async () => {
    const { ctx, world } = await setup();
    const web = node("container_service/web");
    const id = world.tagged.find((t) => t.tags["zenith:resource"] === "container_service/web")!.id;
    world.patch(id, (doc) => {
      const p = doc.properties as Doc;
      delete p.configuration;
      p.template.containers[0].resources.memory = "lots";
      delete p.template.scale.maxReplicas;
    });
    const obs = await driverOf(web).observe!(ctx, web);
    expect(obs.presence).toBe("present");
    expect(obs.attributes.port).toMatchObject({ state: "unknown", reason: "not_inspected" });
    expect(obs.attributes.memoryMb).toMatchObject({ state: "unknown", reason: "not_inspected" });
    expect(obs.attributes.maxReplicas).toMatchObject({ state: "unknown", reason: "not_inspected" });
    expect(obs.attributes.vcpu).toMatchObject({ state: "known", value: 0.5 });
    const v = await driverOf(web).verify!(ctx, web, obs, undefined);
    // unread attributes are not "matches": the configuration check compares only what was read
    expect(v.checks.find((c) => c.id === "configuration")!.passed).toBe(true);
    expect(v.status).not.toBe("passed");
  });

  it("drift is reported against exactly the attributes that differ", async () => {
    const { ctx, world } = await setup();
    const web = node("container_service/web");
    const id = world.tagged.find((t) => t.tags["zenith:resource"] === "container_service/web")!.id;
    world.patch(id, (doc) => {
      (doc.properties as Doc).template.scale.minReplicas = 5;
      (doc.properties as Doc).template.containers[0].resources.cpu = 1;
    });
    const d = driverOf(web);
    const obs = await d.observe!(ctx, web);
    const v = await d.verify!(ctx, web, obs, await d.runtime!(ctx, web));
    expect(v.status).toBe("failed");
    expect(v.checks.find((c) => c.id === "configuration")!.detail).toMatch(/vcpu.*minReplicas|minReplicas.*vcpu/);
  });

  it("a malformed ARM body that is not JSON is an unknown presence", async () => {
    const { ctx, world } = await setup();
    const web = node("container_service/web");
    const id = world.tagged.find((t) => t.tags["zenith:resource"] === "container_service/web")!.id;
    world.extra.push({ match: id, handler: () => ({ status: 200, raw: "<html>not json</html>", headers: {} }) });
    const obs = await driverOf(web).observe!(ctx, web);
    expect(obs.presence).toBe("unknown");
    expect(obs.error).toMatch(/not JSON/);
    // a 200 that is JSON but not a resource is equally not an object to read from
    world.extra.length = 0;
    world.extra.push({ match: id, handler: () => ({ status: 200, body: { hello: "world" }, headers: {} }) });
    expect((await driverOf(web).observe!(ctx, web)).presence).toBe("unknown");
  });
});

describe("boundNative / redactDeep", () => {
  it("drops the largest keys until the bag fits, and redacts secrets by key and by value shape", () => {
    const big = { keep: "small", huge: "x".repeat(10_000), connectionString: "Endpoint=sb://x;SharedAccessKey=abc123", nested: { password: "p", token: "t", note: "Bearer abcdefghijklmnop" }, jwt: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl" };
    const bounded = boundNative(big)!;
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(4096);
    expect(bounded.keep).toBe("small");
    const red = redactDeep(big) as Doc;
    expect(red.connectionString).toBe("[REDACTED]");
    expect(red.nested.password).toBe("[REDACTED]");
    expect(red.nested.token).toBe("[REDACTED]");
    expect(red.jwt).toBe("[REDACTED]");
    expect(JSON.stringify(red)).not.toMatch(/SharedAccessKey=abc123|eyJhbGci/);
  });

  it("the native bag an observation returns is redacted even when the resource carries secret-shaped fields", async () => {
    const { ctx, world } = await setup();
    const vault = node("secret/session-key-1a2b3c4d");
    const id = world.tagged.find((t) => t.tags["zenith:resource"] === "secret/session-key-1a2b3c4d")!.id;
    world.patch(id, (doc) => {
      doc.tags = { ...(doc.tags as object), leaked: "AccountKey=SECRETSECRETSECRET==" };
    });
    const obs = await driverOf(vault).observe!(ctx, vault);
    expect(JSON.stringify(obs)).not.toContain("SECRETSECRETSECRET");
  });
});

describe("runtime: what is running now", () => {
  const web = node("container_service/web");
  const d = driverOf(web);

  it("healthy with two running replicas of the active revision", async () => {
    const { ctx } = await setup();
    const r = await d.runtime!(ctx, web);
    expect(r).toMatchObject({ health: "healthy", counts: { desired: 2, running: 2, notRunning: 0, activeRevisions: 1 }, signals: [], source: d.id, simulated: false });
  });

  it("degraded when a replica is not running or a revision is unhealthy; unhealthy when the revision failed or nothing runs", async () => {
    const { ctx, world } = await setup();
    const appId = world.tagged.find((t) => t.tags["zenith:resource"] === "container_service/web")!.id;
    world.setList(`${appId}/revisions/zn-k3x9q2-web--r1/replicas`, [{ name: "a", properties: { runningState: "Running" } }, { name: "b", properties: { runningState: "NotRunning" } }]);
    const degraded = await d.runtime!(ctx, web);
    expect(degraded.health).toBe("degraded");
    expect(degraded.counts).toMatchObject({ running: 1, notRunning: 1, desired: 2 });
    expect(degraded.signals).toContain("replica_notrunning:b");

    world.setList(`${appId}/revisions`, [{ id: `${appId}/revisions/zn-k3x9q2-web--r1`, name: "zn-k3x9q2-web--r1", properties: { active: true, healthState: "Unhealthy", runningState: "Running" } }]);
    world.setList(`${appId}/revisions/zn-k3x9q2-web--r1/replicas`, [{ name: "a", properties: { runningState: "Running" } }, { name: "b", properties: { runningState: "Running" } }]);
    const unhealthyRev = await d.runtime!(ctx, web);
    expect(unhealthyRev.health).toBe("degraded");
    expect(unhealthyRev.signals).toContain("revision_unhealthy:zn-k3x9q2-web--r1");

    world.setList(`${appId}/revisions`, [{ id: `${appId}/revisions/zn-k3x9q2-web--r1`, name: "zn-k3x9q2-web--r1", properties: { active: true, healthState: "Unhealthy", runningState: "Failed" } }]);
    world.setList(`${appId}/revisions/zn-k3x9q2-web--r1/replicas`, []);
    const failed = await d.runtime!(ctx, web);
    expect(failed.health).toBe("unhealthy");
    expect(failed.signals).toContain("revision_failed:zn-k3x9q2-web--r1");
  });

  it("unknown (never 'healthy') when revisions cannot be read, with the reason as a signal", async () => {
    const { ctx, world } = await setup();
    const appId = world.tagged.find((t) => t.tags["zenith:resource"] === "container_service/web")!.id;
    world.fail(`${appId}/revisions`, { status: 403 });
    expect(await d.runtime!(ctx, web)).toMatchObject({ health: "unknown", counts: {}, signals: ["access_denied"] });
    world.fail(`${appId}/revisions`, { status: 429, headers: { "retry-after": "2" } });
    expect(await d.runtime!(ctx, web)).toMatchObject({ health: "unknown", signals: ["throttled"] });
    world.failures.delete(`${appId}/revisions`.toLowerCase());
    world.setList(`${appId}/revisions`, []);
    expect(await d.runtime!(ctx, web)).toMatchObject({ health: "unknown", signals: ["no_active_revision"] });
    world.tagged.length = 0;
    expect(await d.runtime!(ctx, web)).toMatchObject({ health: "unknown", signals: ["not_found"] });
  });

  it("a scheduled job is judged by its latest execution", async () => {
    const { ctx, world } = await setup();
    const job = node("scheduled_job/report");
    const jd = driverOf(job);
    const jobId = world.tagged.find((t) => t.tags["zenith:resource"] === "scheduled_job/report")!.id;
    expect((await jd.runtime!(ctx, job)).health).toBe("healthy");
    world.setList(`${jobId}/executions`, [{ name: "e3", properties: { status: "Failed" } }, { name: "e2", properties: { status: "Succeeded" } }]);
    const failed = await jd.runtime!(ctx, job);
    expect(failed.health).toBe("unhealthy");
    expect(failed.signals).toContain("last_execution_failed");
    world.setList(`${jobId}/executions`, []);
    expect(await jd.runtime!(ctx, job)).toMatchObject({ health: "unknown", signals: ["no_executions"] });
  });

  it("postgres states, redis provisioning and queue dead letters map to health", async () => {
    const { ctx, world } = await setup();
    const db = node("postgres/db");
    const dbId = world.tagged.find((t) => t.tags["zenith:resource"] === "postgres/db")!.id;
    expect((await driverOf(db).runtime!(ctx, db)).health).toBe("healthy");
    world.patch(dbId, (doc) => ((doc.properties as Doc).state = "Updating"));
    expect((await driverOf(db).runtime!(ctx, db)).health).toBe("degraded");
    world.patch(dbId, (doc) => {
      (doc.properties as Doc).state = "Ready";
      (doc.properties as Doc).highAvailability.state = "FailingOver";
    });
    const ha = await driverOf(db).runtime!(ctx, db);
    expect(ha.health).toBe("degraded");
    expect(ha.signals).toContain("ha:FailingOver");
    world.patch(dbId, (doc) => ((doc.properties as Doc).state = "Stopped"));
    expect((await driverOf(db).runtime!(ctx, db)).health).toBe("unhealthy");

    const queue = node("queue/jobs");
    const nsId = world.tagged.find((t) => t.tags["zenith:resource"] === "queue/jobs")!.id;
    const qPath = Object.keys(Object.fromEntries(world.docs)).find((k) => k.startsWith(nsId.toLowerCase() + "/queues/"))!;
    const q = world.docs.get(qPath) as Doc;
    expect(await driverOf(queue).runtime!(ctx, queue)).toMatchObject({ health: "healthy", counts: { active: 4, deadLetter: 0 } });
    q.properties.countDetails.deadLetterMessageCount = 3;
    const dlq = await driverOf(queue).runtime!(ctx, queue);
    expect(dlq.health).toBe("degraded");
    expect(dlq.signals).toContain("dead_letter_messages:3");
  });
});

describe("load balancer observation (Container Apps ingress)", () => {
  it("is healthy when every routed app has external ingress, an FQDN and its TLS host is bound", async () => {
    const { ctx } = await setup();
    const lb = node("load_balancer/public");
    const d = driverOf(lb);
    const obs = await d.observe!(ctx, lb);
    expect(obs.attributes).toMatchObject({ externalTargets: { state: "known", value: 1 }, tlsHostsBound: { state: "known", value: 1 } });
    expect(JSON.stringify(obs.native)).toContain("container-apps-environment-ingress");
    expect((await d.runtime!(ctx, lb)).health).toBe("healthy");
  });

  it("notices an unbound host and an app that lost its external ingress", async () => {
    const { ctx, world } = await setup();
    const lb = node("load_balancer/public");
    const d = driverOf(lb);
    const appId = world.tagged.find((t) => t.tags["zenith:resource"] === "container_service/web")!.id;
    world.patch(appId, (doc) => {
      const ing = (doc.properties as Doc).configuration.ingress;
      ing.customDomains[0].bindingType = "Disabled";
    });
    const obs = await d.observe!(ctx, lb);
    expect(obs.attributes.tlsHostsBound).toMatchObject({ value: 0 });
    const v = await d.verify!(ctx, lb, obs, await d.runtime!(ctx, lb));
    expect(v.checks.find((c) => c.id === "configuration")!.passed).toBe(false);
    world.patch(appId, (doc) => ((doc.properties as Doc).configuration.ingress.external = false));
    expect((await d.runtime!(ctx, lb)).health).toBe("unhealthy");
  });
});

describe("drivers that look through a parent", () => {
  it("a firewall rule is found inside its NSG; a rule that is not there is missing", async () => {
    const { ctx, world } = await setup();
    const fw = node("firewall/web-to-db");
    const d = driverOf(fw);
    expect((await d.observe!(ctx, fw)).presence).toBe("present");
    const nsg = world.tagged.find((t) => t.name === "nsg-pg")!;
    world.patch(nsg.id, (doc) => ((doc.properties as Doc).securityRules = []));
    expect((await d.observe!(ctx, fw)).presence).toBe("missing");
    world.tagged.splice(world.tagged.indexOf(nsg), 1);
    expect((await d.observe!(ctx, fw)).presence).toBe("missing");
  });

  it("a rule whose observed port or source differs is drift", async () => {
    const { ctx, world } = await setup();
    const fw = node("firewall/web-to-db");
    const nsg = world.tagged.find((t) => t.name === "nsg-pg")!;
    world.patch(nsg.id, (doc) => {
      const rule = (doc.properties as Doc).securityRules[0];
      rule.properties.destinationPortRange = "5433";
      rule.properties.sourceAddressPrefix = "*";
    });
    const d = driverOf(fw);
    const obs = await d.observe!(ctx, fw);
    expect(obs.attributes.port).toMatchObject({ value: 5433 });
    expect(obs.attributes.source).toMatchObject({ value: "*" });
    expect((await d.verify!(ctx, fw, obs)).status).toBe("failed");
  });

  it("a subnet is found through its VNet by name; identities read their role assignments", async () => {
    const { ctx, world } = await setup();
    const sub = node("subnet/private-a");
    expect((await driverOf(sub).observe!(ctx, sub)).attributes.cidr).toMatchObject({ state: "known", value: "10.0.10.0/24" });
    const id = node("identity/web");
    const obs = await driverOf(id).observe!(ctx, id);
    expect(obs.attributes.roles).toMatchObject({ state: "known", value: ["AcrPull", "Azure Service Bus Data Sender", "Key Vault Secrets User", "Storage Blob Data Contributor"] });
    // a role nobody intended shows up as drift, by GUID, never hidden
    world.setList(`/subscriptions/${SUB}/providers/Microsoft.Authorization/roleAssignments`, [
      { properties: { principalId: "0f0f0f0f-1111-2222-3333-444444444444", roleDefinitionId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/8e3af657-a8ff-443c-a75c-2fe8c4bcb635` } },
    ]);
    const drift = await driverOf(id).observe!(ctx, id);
    expect(JSON.stringify(drift.attributes.roles)).toContain("custom-or-unknown:8e3af657");
    // if the role list cannot be read the attribute is unknown, not empty
    world.fail(`/subscriptions/${SUB}/providers/Microsoft.Authorization/roleAssignments`, { status: 403 });
    expect((await driverOf(id).observe!(ctx, id)).attributes.roles).toMatchObject({ state: "unknown" });
  });

  it("DNS record: found via the longest matching zone; its ownership TXT is verified", async () => {
    const { ctx, world } = await setup();
    const rec = node("dns_record/app.example.com");
    const d = driverOf(rec);
    const obs = await d.observe!(ctx, rec);
    expect(obs.presence).toBe("present");
    expect(obs.attributes.ttl).toMatchObject({ value: 300 });
    world.docs.delete(`/subscriptions/${SUB}/resourcegroups/dns-rg/providers/microsoft.network/dnszones/example.com/txt/asuid.app`);
    const v = await d.verify!(ctx, rec, obs);
    expect(v.checks.find((c) => c.id === "ownership_txt")!.passed).toBe(false);
  });

  it("the build pipeline is 'present' only while its output registry is; managed certificates are read from the environment", async () => {
    const { ctx, world } = await setup();
    const pipeline = node("build_pipeline/web");
    expect((await driverOf(pipeline).observe!(ctx, pipeline)).presence).toBe("present");
    const cert = node("tls_certificate/app.example.com");
    const obs = await driverOf(cert).observe!(ctx, cert);
    expect(obs.attributes.subjectName).toMatchObject({ value: "app.example.com" });
    const caeId = world.tagged.find((t) => t.type === "Microsoft.App/managedEnvironments")!.id;
    world.setList(`${caeId}/managedCertificates`, [{ name: "c", properties: { subjectName: "app.example.com", provisioningState: "Pending" } }]);
    const v = await driverOf(cert).verify!(ctx, cert, await driverOf(cert).observe!(ctx, cert));
    expect(v.checks.find((c) => c.id === "issued")!.passed).toBe("unknown");
    world.setList(`${caeId}/managedCertificates`, []);
    expect((await driverOf(cert).observe!(ctx, cert)).presence).toBe("missing");
    world.tagged.length = 0;
    expect((await driverOf(pipeline).observe!(ctx, pipeline)).presence).toBe("missing");
  });

  it("a key vault's value check reads version metadata only", async () => {
    const { ctx, arm } = await setup();
    const secret = node("secret/session-key-1a2b3c4d");
    const d = driverOf(secret);
    await d.verify!(ctx, secret, await d.observe!(ctx, secret));
    const vaultCalls = arm.requests.filter((r) => r.pathname.startsWith("/secrets/"));
    expect(vaultCalls.length).toBeGreaterThan(0);
    for (const c of vaultCalls) {
      expect(c.method).toBe("GET");
      expect(c.pathname).toMatch(/\/versions$/); // the secret value endpoint is never called
    }
  });
});

describe("discover", () => {
  it("lists candidates of the driver's type and marks only this environment's managed objects as Zenith-tagged", async () => {
    const { ctx, world } = await setup();
    world.tagged.push({ id: `/subscriptions/${SUB}/resourceGroups/other/providers/Microsoft.App/containerApps/legacy`, name: "legacy", type: "Microsoft.App/containerApps", location: "eastus", tags: { team: "x" } });
    world.tagged.push({ id: `/subscriptions/${SUB}/resourceGroups/other/providers/Microsoft.App/containerApps/foreign`, name: "foreign", type: "Microsoft.App/containerApps", location: "eastus", tags: { "zenith:managed": "true", "zenith:environment": "env_someone_else" } });
    world.tagged.push({ id: "/subscriptions/99999999-9999-9999-9999-999999999999/resourceGroups/x/providers/Microsoft.App/containerApps/elsewhere", name: "elsewhere", type: "Microsoft.App/containerApps", location: "eastus", tags: {} });
    const web = node("container_service/web");
    const found = await driverOf(web).discover!(ctx);
    expect(found.map((f) => f.name).sort()).toEqual(["foreign", "legacy", "zn-k3x9q2-web"]);
    const byName = Object.fromEntries(found.map((f) => [f.name, f]));
    expect(byName["zn-k3x9q2-web"]).toMatchObject({ provider: "azure", kind: "container_service", nativeType: "azure:container_app", zenithTagged: true, region: "westeurope", attributes: { resourceGroup: RG } });
    expect(byName.legacy.zenithTagged).toBe(false);
    expect(byName.foreign.zenithTagged).toBe(false); // another environment's object is never ours
    // candidates only: discover reports nothing as managed beyond the tag fact
    expect(found.every((f) => f.externalId.startsWith(`/subscriptions/${SUB}/`))).toBe(true);
  });

  it("only drivers with an ARM type discover; DNS zones are listed by zone API", async () => {
    const { ctx } = await setup();
    expect(AZURE_DRIVERS.filter((d) => d.discover).map((d) => d.nativeType)).not.toContain("azure:subnet");
    const zones = await driverOf(node("dns_zone/example.com")).discover!(ctx);
    expect(zones).toEqual([]); // the generic resource search does not list DNS zones in the fake; they are found by observe
  });

  it("expected attributes never throw for any node of the sample graph", () => {
    for (const n of nodes) expect(() => driverOf(n).expectedAttributes!(n)).not.toThrow();
    expect(driverOf(mkNode("x/y", "network", "azure:virtual_network", { zones: 1 })).expectedAttributes!(mkNode("x/y", "network", "azure:virtual_network", { zones: 1 }))).toEqual({ cidr: undefined });
  });
});

void ENV_ID;
