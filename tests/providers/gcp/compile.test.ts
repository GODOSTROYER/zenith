import { describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { findDriver, listDrivers } from "@/lib/drivers/types";
import { gcpDrivers, registerGcpDrivers } from "@/lib/providers/gcp/drivers";
import { GcpCompileError } from "@/lib/providers/gcp/errors";
import { NATIVE_TYPE_TABLE } from "@/lib/resources/native-types";
import type { ResourceNode } from "@/lib/resources/types";
import { stableJson } from "@/lib/tofu/stable";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { IMAGE, PROJECT, REGION, SECRET_REF, TAGS, compileContext, environmentNodes, graphOf, mk } from "./_fixtures";

type Json = Record<string, unknown>;

const allFragments = (nodes = environmentNodes()) => compileContext(nodes).compileAll();
const resourcesOf = (fragments: Map<string, TofuFragment>): { type: string; label: string; body: Json; node: string }[] => {
  const out: { type: string; label: string; body: Json; node: string }[] = [];
  for (const [node, f] of fragments) for (const [type, named] of Object.entries(f.resource ?? {})) for (const [label, body] of Object.entries(named)) out.push({ type, label, body: body as Json, node });
  return out;
};
const ofType = (fragments: Map<string, TofuFragment>, type: string) => resourcesOf(fragments).filter((r) => r.type === type);
const walk = (v: unknown, fn: (key: string, value: unknown, path: string) => void, path = ""): void => {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, fn, `${path}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { fn(k, x, `${path}.${k}`); walk(x, fn, `${path}.${k}`); }
};
const compileOne = (node: ResourceNode, nodes: ResourceNode[] = environmentNodes()) => {
  const all = [...nodes.filter((n) => n.address !== node.address), node];
  return compileContext(all).compileAll().get(node.address)!;
};
const replaceSpec = (address: string, patch: Json, nodes = environmentNodes()): ResourceNode[] => nodes.map((n) => (n.address === address ? { ...n, spec: { ...n.spec, ...patch } } : n));
const fragmentFor = (address: string, nodes: ResourceNode[]) => compileContext(nodes).compileAll().get(address)!;

describe("registration", () => {
  it("registers exactly the native types of the native-type table for the kinds it serves", () => {
    const table = Object.values(NATIVE_TYPE_TABLE.gcp);
    const served = [
      "gcp:vpc_network", "gcp:subnetwork", "gcp:firewall_rule", "gcp:cloud_run_service", "gcp:cloud_run_job", "gcp:cloud_sql_instance", "gcp:memorystore_instance",
      "gcp:storage_bucket", "gcp:pubsub_topic", "gcp:secret_manager_secret", "gcp:service_account", "gcp:log_bucket", "gcp:artifact_registry_repository",
      "gcp:cloud_build_trigger", "gcp:global_http_lb", "gcp:managed_ssl_certificate", "gcp:dns_managed_zone", "gcp:dns_record_set",
    ];
    expect(gcpDrivers.map((d) => d.nativeType).sort()).toEqual([...served].sort());
    for (const t of served) expect(table).toContain(t);
    // kinds with no driver here are visibly absent, not faked
    for (const t of ["gcp:compute_instance", "gcp:cloud_function", "gcp:gcs_static_site", "gcp:gke_cluster", "gcp:persistent_disk"]) expect(gcpDrivers.some((d) => d.nativeType === t)).toBe(false);
  });

  it("uses ids of the form gcp.<suffix>@1, provider gcp, and declares only contract evidence", () => {
    for (const d of gcpDrivers) {
      expect(d.id).toBe(`gcp.${d.nativeType.slice(4)}@1`);
      expect(d.provider).toBe("gcp");
      expect(d.capabilities.compile).toBe(true);
      expect(Object.values(d.capabilities.evidence).every((e) => e === "contract")).toBe(true);
      for (const op of d.capabilities.operations) expect(d.operations?.[op]).toBeTypeOf("function");
      for (const key of ["compile", "observe", "runtime", "verify", "discover"] as const) {
        expect(Boolean(d[key])).toBe(d.capabilities[key]);
        expect(d.capabilities.evidence[key] !== undefined).toBe(d.capabilities[key]);
      }
    }
  });

  it("maps each portable kind's native type to its driver and registers idempotently", () => {
    registerGcpDrivers();
    registerGcpDrivers();
    expect(listDrivers("gcp")).toHaveLength(gcpDrivers.length);
    for (const node of environmentNodes()) expect(findDriver("gcp", node.nativeType)?.nativeType).toBe(node.nativeType);
  });

  it("declares the day-two operations it implements", () => {
    const ops = Object.fromEntries(gcpDrivers.map((d) => [d.nativeType, d.capabilities.operations]));
    expect(ops["gcp:cloud_run_service"]).toEqual(["service.restart", "service.scale"]);
    expect(ops["gcp:cloud_sql_instance"]).toEqual(["database.snapshot"]);
  });
});

describe("structure, determinism and assembly", () => {
  it("every fragment defines every address it claims; the primary resource is addresses[0]", () => {
    for (const [node, f] of allFragments()) {
      const defined = new Set<string>();
      for (const [t, named] of Object.entries(f.resource ?? {})) for (const n of Object.keys(named)) defined.add(`${t}.${n}`);
      for (const [t, named] of Object.entries(f.data ?? {})) for (const n of Object.keys(named)) defined.add(`data.${t}.${n}`);
      for (const a of f.addresses) expect(defined, `${node}: ${a}`).toContain(a);
      expect(f.addresses.length === 0 || f.addresses[0].startsWith("google_") || f.addresses[0].startsWith("data.google_")).toBe(true);
    }
    // log groups and public firewall rules compile nothing on purpose
    const frags = allFragments();
    expect(frags.get("log_group/web")!.addresses).toEqual([]);
    expect(frags.get("firewall/public")!.addresses).toEqual([]);
  });

  it("is deterministic: compiling twice, and in another node order, gives identical JSON", () => {
    const a = allFragments();
    const b = allFragments();
    const c = allFragments([...environmentNodes()].reverse());
    const ser = (m: Map<string, TofuFragment>) => stableJson([...m.entries()].sort(([x], [y]) => (x < y ? -1 : 1)));
    expect(ser(a)).toBe(ser(b));
    expect(ser(a)).toBe(ser(c));
  });

  it("assembles into a gcp workspace with pinned providers and no credentials", () => {
    const nodes = environmentNodes();
    const ws = assembleWorkspace({
      graph: graphOf(nodes),
      fragments: compileContext(nodes).compileAll(),
      providerSet: "gcp",
      region: REGION,
      backend: { kind: "local", path: "/tmp/state" },
      tags: TAGS,
      providerConfig: { google: { project: PROJECT } },
    });
    const versions = JSON.parse(ws.files.find((f) => f.path === "versions.tf.json")!.content);
    expect(versions.terraform.required_providers.google.version).toBe("= 8.5.0");
    const providers = JSON.parse(ws.files.find((f) => f.path === "providers.tf.json")!.content);
    expect(providers.provider.google).toEqual({ project: PROJECT, region: REGION });
    expect(Object.keys(ws.addressMap).sort()).toEqual(nodes.map((n) => n.address).sort());
    expect(ws.addressMap["service/web"]).toContain("google_cloud_run_v2_service.service_web");
    expect(ws.addressMap["log_group/web"]).toEqual([]);
    expect(ws.lockfile).toContain("registry.opentofu.org/hashicorp/google");
  });

  it("uses ctx.ref for cross-node values and never another node's hard-coded label", () => {
    const refs = new Set<string>();
    const ctx = compileContext(environmentNodes());
    const original = ctx.ctx.ref;
    ctx.ctx.ref = (a, attr) => {
      refs.add(`${a}.${attr}`);
      return original(a, attr);
    };
    ctx.compileAll();
    for (const expected of ["network/main.id", "network/main.name", "subnet/private-a.name", "resource/db.private_ip_address", "resource/cache.host", "secret/api-key.id", "identity/web.email", "service/web.name", "load_balancer/public.ip_address", "dns_zone/example.com.name", "resource/registry.name"]) {
      expect(refs, expected).toContain(expected);
    }
  });
});

describe("labels and names", () => {
  it("puts GCP-valid Zenith labels on every labelled resource", () => {
    const labelled = new Set(["google_cloud_run_v2_service", "google_cloud_run_v2_job", "google_redis_instance", "google_storage_bucket", "google_pubsub_topic", "google_pubsub_subscription", "google_secret_manager_secret", "google_artifact_registry_repository", "google_compute_global_address", "google_compute_global_forwarding_rule", "google_dns_managed_zone"]);
    const seen = new Set<string>();
    for (const r of resourcesOf(allFragments())) {
      if (labelled.has(r.type) && !(r.type === "google_compute_global_address" && r.body.purpose === "VPC_PEERING")) {
        const labels = r.body.labels as Record<string, string>;
        expect(labels, `${r.type}.${r.label}`).toBeDefined();
        expect(labels.zenith_environment).toBe("env_1");
        expect(labels.zenith_workspace).toBe("ws_1");
        expect(labels.zenith_managed).toBe("true");
        seen.add(r.type);
      }
    }
    expect([...seen].sort()).toEqual([...labelled].sort());
    walk(allFragments(), (k, v) => {
      if (k === "labels" || k === "user_labels") {
        for (const [lk, lv] of Object.entries(v as Json)) {
          expect(lk).toMatch(/^[a-z][a-z0-9_-]{0,62}$/);
          expect(String(lv)).toMatch(/^[a-z0-9_-]{0,63}$/);
        }
      }
    });
    const sql = ofType(allFragments(), "google_sql_database_instance")[0];
    expect(((sql.body.settings as Json[])[0].user_labels as Json).zenith_environment).toBe("env_1");
  });

  it("carries tags in description for objects that have no labels (network, subnets, firewalls)", () => {
    for (const type of ["google_compute_network", "google_compute_subnetwork", "google_compute_firewall"]) {
      for (const r of ofType(allFragments(), type)) expect(String(r.body.description)).toContain("zenith_environment=env_1");
    }
  });

  it("keeps cloud-side names inside provider limits and unique, even for very long addresses", () => {
    const longName = "a".repeat(150);
    const nodes = [
      ...environmentNodes(),
      mk(`service/${longName}`, "container_service", { size: "small", vcpu: 1, memoryMb: 512, artifact: { type: "image", ref: IMAGE }, env: [], zones: 1, subnetTier: "private", workload: "web", replicas: 1 }, ["network/main", "subnet/private-a"]),
      mk(`resource/${longName}`, "object_store", { size: "small", versioning: false, publicAccess: false, deletionPolicy: "deny", encryption: true }),
      mk(`identity/${longName}`, "identity", { principal: "workload", workload: `service/${longName}`, grants: [] }),
    ];
    const frags = compileContext(nodes, { namePrefix: "zenith-env-abcdef12" }).compileAll();
    const names: Record<string, string[]> = {};
    for (const r of resourcesOf(frags)) {
      const name = (r.body.name ?? r.body.repository_id ?? r.body.secret_id ?? r.body.account_id) as string | undefined;
      if (typeof name === "string" && !name.includes("${")) (names[r.type] ??= []).push(name);
    }
    const limit: Record<string, number> = { google_cloud_run_v2_service: 49, google_storage_bucket: 63, google_service_account: 30, google_compute_network: 63, google_sql_database_instance: 98, google_redis_instance: 40 };
    for (const [type, max] of Object.entries(limit)) {
      for (const n of names[type] ?? []) expect(n.length, `${type} ${n}`).toBeLessThanOrEqual(max);
    }
    for (const n of names.google_service_account ?? []) expect(n).toMatch(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
    for (const n of names.google_storage_bucket ?? []) expect(n).toMatch(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
    for (const n of names.google_cloud_run_v2_service ?? []) expect(n).toMatch(/^[a-z]([a-z0-9-]*[a-z0-9])?$/);
    for (const list of Object.values(names)) expect(new Set(list).size).toBe(list.length);
  });

  it("scopes bucket names to the environment so two environments never collide", () => {
    const a = compileContext(environmentNodes(), { environmentId: "env_1" }).compileAll();
    const b = compileContext(environmentNodes(), { environmentId: "env_2" }).compileAll();
    const name = (m: Map<string, TofuFragment>) => ofType(m, "google_storage_bucket").find((r) => r.node === "resource/uploads")!.body.name;
    expect(name(a)).not.toBe(name(b));
  });
});

describe("static safety checks over the compiled environment", () => {
  const frags = allFragments();
  const json = JSON.stringify([...frags.values()]);

  it("contains no secret values or credential-bearing resources", () => {
    for (const forbidden of ["secret_data", "google_secret_manager_secret_version", "google_service_account_key", "random_password", "root_password", "\"password\"", "private_key", "auth_string", "client_secret", "access_token"]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
    // the vault reference is resolved to a Secret Manager resource, never copied
    expect(json).not.toContain(SECRET_REF);
    expect(json).not.toContain("vault:");
    const web = ofType(frags, "google_cloud_run_v2_service").find((r) => r.node === "service/web")!;
    const env = ((web.body.template as Json[])[0].containers as Json[])[0].env as Json[];
    const api = env.find((e) => e.name === "API_KEY")!;
    expect(api.value).toBeUndefined();
    expect(api.value_source).toEqual([{ secret_key_ref: [{ secret: "${google_secret_manager_secret.secret_api_key.id}", version: "latest" }] }]);
    expect(ofType(frags, "google_sql_user").every((r) => r.body.type === "CLOUD_IAM_SERVICE_ACCOUNT" && r.body.password === undefined)).toBe(true);
  });

  it("grants only predefined, non-primitive roles and never a wildcard member", () => {
    const iam = resourcesOf(frags).filter((r) => r.type.endsWith("_iam_member"));
    expect(iam.length).toBeGreaterThan(8);
    for (const r of iam) {
      expect(String(r.body.role), r.label).toMatch(/^roles\/[a-zA-Z]+\.[a-zA-Z.]+$/);
      expect(["roles/owner", "roles/editor", "roles/viewer"]).not.toContain(r.body.role);
      expect(String(r.body.role)).not.toMatch(/admin$|\.admin\b|iam\.securityAdmin/i);
      expect(String(r.body.member)).not.toMatch(/allAuthenticatedUsers|domain:|group:|user:/);
    }
    // allUsers exists exactly once: run.invoker on the public web service behind the LB
    const all = iam.filter((r) => r.body.member === "allUsers");
    expect(all).toHaveLength(1);
    expect(all[0].type).toBe("google_cloud_run_v2_service_iam_member");
    expect(all[0].body.role).toBe("roles/run.invoker");
    expect(all[0].node).toBe("service/web");
    // project-level bindings are limited to three roles and Cloud SQL ones are pinned to the instance
    const project = iam.filter((r) => r.type === "google_project_iam_member");
    expect(new Set(project.map((r) => r.body.role))).toEqual(new Set(["roles/logging.logWriter", "roles/cloudsql.client", "roles/cloudsql.instanceUser"]));
    for (const r of project.filter((p) => String(p.body.role).startsWith("roles/cloudsql"))) {
      const cond = (r.body.condition as Json[])[0];
      expect(String(cond.expression)).toContain("resource.name ==");
      expect(String(cond.expression)).toContain("google_sql_database_instance.resource_db.name");
    }
  });

  it("never makes a bucket public", () => {
    const buckets = ofType(frags, "google_storage_bucket");
    expect(buckets).toHaveLength(2);
    for (const b of buckets) {
      expect(b.body.public_access_prevention).toBe("enforced");
      expect(b.body.uniform_bucket_level_access).toBe(true);
    }
    expect(resourcesOf(frags).filter((r) => r.type.startsWith("google_storage_") && r.type.includes("iam") && (r.body.member === "allUsers" || r.body.member === "allAuthenticatedUsers"))).toEqual([]);
    expect(json).not.toContain("google_storage_default_object_access_control");
    expect(json).not.toContain("google_storage_bucket_acl");
  });

  it("gives Cloud SQL a private IP only, TLS, IAM auth, protection and a final backup", () => {
    const sql = ofType(frags, "google_sql_database_instance");
    expect(sql).toHaveLength(1);
    const s = (sql[0].body.settings as Json[])[0];
    const ip = (s.ip_configuration as Json[])[0];
    expect(ip.ipv4_enabled).toBe(false);
    expect(ip.authorized_networks).toBeUndefined();
    expect(String(ip.private_network)).toContain("google_compute_network.network_main.id");
    expect(ip.ssl_mode).toBe("ENCRYPTED_ONLY");
    expect(s.database_flags).toContainEqual({ name: "cloudsql.iam_authentication", value: "on" });
    expect(sql[0].body.deletion_protection).toBe(true);
    expect(sql[0].body.deletion_policy).toBe("PREVENT");
    expect(s.deletion_protection_enabled).toBe(true);
    expect(s.final_backup_config).toEqual([{ enabled: true, retention_days: 30 }]);
    expect(sql[0].body.root_password).toBeUndefined();
    expect(sql[0].body.depends_on).toEqual(["google_service_networking_connection.network_main_psa"]);
  });

  it("keeps Memorystore private, TLS-only and protected", () => {
    const r = ofType(frags, "google_redis_instance")[0].body;
    expect(r.connect_mode).toBe("PRIVATE_SERVICE_ACCESS");
    expect(r.transit_encryption_mode).toBe("SERVER_AUTHENTICATION");
    expect(r.auth_enabled).toBe(false);
    expect(r.deletion_protection).toBe(true);
    expect(r.deletion_policy).toBe("PREVENT");
  });

  it("runs every Cloud Run revision as an explicit service account and never exposes direct access by default", () => {
    for (const r of [...ofType(frags, "google_cloud_run_v2_service"), ...ofType(frags, "google_cloud_run_v2_job")]) {
      const tpl = (r.body.template as Json[])[0];
      const inner = r.type.endsWith("job") ? ((tpl.template as Json[])[0] as Json) : tpl;
      expect(String(inner.service_account), r.label).toMatch(/^\$\{google_service_account\.[a-z0-9_]+\.email\}$/);
      expect(r.body.deletion_protection).toBe(false);
    }
    for (const r of ofType(frags, "google_cloud_run_v2_service")) expect(r.body.ingress).not.toBe("INGRESS_TRAFFIC_ALL");
  });

  it("terminates TLS ≥ 1.2 and redirects http to https on the load balancer", () => {
    expect(ofType(frags, "google_compute_ssl_policy")[0].body).toMatchObject({ min_tls_version: "TLS_1_2", profile: "MODERN" });
    const https = ofType(frags, "google_compute_target_https_proxy")[0].body;
    expect(String(https.ssl_policy)).toContain("google_compute_ssl_policy");
    const http = ofType(frags, "google_compute_target_http_proxy")[0].body;
    const redirect = ofType(frags, "google_compute_url_map").find((r) => String(r.label).includes("redirect"))!;
    expect(String(http.url_map)).toContain(redirect.label);
    expect(redirect.body.default_url_redirect).toEqual([{ https_redirect: true, redirect_response_code: "MOVED_PERMANENTLY_DEFAULT", strip_query: false }]);
  });

  it("contains no provisioner, connection, or filesystem-reading expression", () => {
    walk(frags, (k, v) => {
      expect(["provisioner", "connection"]).not.toContain(k);
      if (typeof v === "string" && v.includes("${")) expect(v).not.toMatch(/\b(file|templatefile|fileexists|abspath)\s*\(/);
    });
  });
});

describe("injection", () => {
  it("escapes template syntax in env values so manifest text is never evaluated", () => {
    const web = ofType(allFragments(), "google_cloud_run_v2_service").find((r) => r.node === "service/web")!;
    const env = ((web.body.template as Json[])[0].containers as Json[])[0].env as { name: string; value?: string }[];
    expect(env.find((e) => e.name === "GREETING")!.value).toBe("hello $${not_a_template} %%{if}");
  });

  it("the workspace assembler still refuses a literal that looks like a file read", () => {
    const nodes = replaceSpec("service/web", { env: [{ key: "X", value: '${file("/proc/self/environ")}' }] });
    expect(() =>
      assembleWorkspace({ graph: graphOf(nodes), fragments: compileContext(nodes).compileAll(), providerSet: "gcp", region: REGION, backend: { kind: "local" }, tags: TAGS })
    ).toThrow(/forbidden|filesystem/i);
  });

  it("sanitizes hostile addresses into valid labels and names", () => {
    const evil = mk('service/x"; ${file("/etc/passwd")}', "container_service", { size: "small", vcpu: 1, memoryMb: 512, artifact: { type: "image", ref: IMAGE }, env: [], zones: 1, subnetTier: "private", workload: "web", replicas: 1 }, ["network/main", "subnet/private-a"]);
    const f = compileOne(evil);
    const json = JSON.stringify(f);
    expect(json).not.toContain("file(");
    const svc = f.resource!.google_cloud_run_v2_service as Record<string, Json>;
    const [label, body] = Object.entries(svc)[0];
    expect(label).toMatch(/^[a-z0-9_]+$/);
    expect(body.name).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
  });

  it("refuses domain names with template or shell characters", () => {
    for (const bad of ["a.com\"; drop", "${x}.com", "*.example.com", "under_score.example.com", "no-tld"]) {
      const nodes = replaceSpec("dns_zone/example.com", { name: bad });
      expect(() => fragmentFor("dns_zone/example.com", nodes), bad).toThrow(GcpCompileError);
    }
  });
});

describe("cloud run service", () => {
  it("derives instance bounds from replicas, sizing from vcpu/memory, and Direct VPC egress", () => {
    const web = ofType(allFragments(), "google_cloud_run_v2_service").find((r) => r.node === "service/web")!;
    const tpl = (web.body.template as Json[])[0];
    expect(tpl.scaling).toEqual([{ min_instance_count: 2, max_instance_count: 10 }]);
    const c = (tpl.containers as Json[])[0];
    expect((c.resources as Json[])[0].limits).toEqual({ cpu: "1", memory: "512Mi" });
    expect(c.image).toBe(IMAGE);
    expect(c.ports).toEqual([{ container_port: 3000 }]);
    expect((c.startup_probe as Json[])[0].http_get).toEqual([{ path: "/healthz", port: 3000 }]);
    expect((c.liveness_probe as Json[])[0].http_get).toEqual([{ path: "/healthz", port: 3000 }]);
    const vpc = (tpl.vpc_access as Json[])[0];
    expect(vpc.egress).toBe("PRIVATE_RANGES_ONLY");
    expect((vpc.network_interfaces as Json[])[0]).toMatchObject({ network: "${google_compute_network.network_main.name}", subnetwork: "${google_compute_subnetwork.subnet_private_a.name}" });
    expect(tpl.vpc_access && (web.body.lifecycle as Json).ignore_changes).toContain('template[0].annotations["zenith.dev/restart-token"]');
  });

  it("maps ingress: web → load balancer only, worker → internal, explicit values honoured, unknown never public", () => {
    const ingress = (patch: Json, addr = "service/web") => ((compileOne({ ...environmentNodes().find((n) => n.address === addr)!, spec: { ...environmentNodes().find((n) => n.address === addr)!.spec, ...patch } }).resource!.google_cloud_run_v2_service as Record<string, Json>));
    const only = (m: Record<string, Json>) => Object.values(m)[0].ingress;
    expect(only(ingress({}))).toBe("INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER");
    expect(only(ingress({}, "service/worker"))).toBe("INGRESS_TRAFFIC_INTERNAL_ONLY");
    expect(only(ingress({ ingress: "internal" }))).toBe("INGRESS_TRAFFIC_INTERNAL_ONLY");
    expect(only(ingress({ ingress: "public" }))).toBe("INGRESS_TRAFFIC_ALL");
    expect(only(ingress({ ingress: "alb" }))).toBe("INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER");
    expect(only(ingress({ ingress: "nginx" }, "service/worker"))).toBe("INGRESS_TRAFFIC_INTERNAL_ONLY");
  });

  it("adds the public invoker binding only for a web service that is not internal-only", () => {
    const has = (patch: Json, addr: string) => {
      const base = environmentNodes().find((n) => n.address === addr)!;
      return Boolean(compileOne({ ...base, spec: { ...base.spec, ...patch } }).resource!.google_cloud_run_v2_service_iam_member);
    };
    expect(has({}, "service/web")).toBe(true);
    expect(has({ ingress: "internal" }, "service/web")).toBe(false);
    expect(has({}, "service/worker")).toBe(false);
  });

  it("uses the identity node's service account, else a dedicated permission-less one (never the default account)", () => {
    const frags = allFragments();
    const web = ofType(frags, "google_cloud_run_v2_service").find((r) => r.node === "service/web")!;
    expect(((web.body.template as Json[])[0]).service_account).toBe("${google_service_account.identity_web.email}");
    const worker = ofType(frags, "google_cloud_run_v2_service").find((r) => r.node === "service/worker")!;
    expect(((worker.body.template as Json[])[0]).service_account).toBe("${google_service_account.service_worker_run.email}");
    expect(ofType(frags, "google_service_account").some((r) => r.label === "service_worker_run")).toBe(true);
    // the dedicated account has no binding at all
    expect(resourcesOf(frags).filter((r) => r.type.endsWith("_iam_member") && String(r.body.member).includes("service_worker_run"))).toEqual([]);
  });

  it("omits VPC access when the node has no private subnet dependency", () => {
    const nodes = environmentNodes().map((n) => (n.address === "service/worker" ? { ...n, dependsOn: ["network/main"] } : n));
    const f = fragmentFor("service/worker", nodes);
    const tpl = ((f.resource!.google_cloud_run_v2_service as Record<string, Json>).service_worker.template as Json[])[0];
    expect(tpl.vpc_access).toBeUndefined();
  });

  it("clamps cpu/memory to Cloud Run's lattice", () => {
    const tpl = (patch: Json) => {
      const n = { ...environmentNodes().find((x) => x.address === "service/web")!, spec: { ...environmentNodes().find((x) => x.address === "service/web")!.spec, ...patch } };
      return (((compileOne(n).resource!.google_cloud_run_v2_service as Record<string, Json>).service_web.template as Json[])[0].containers as Json[])[0].resources as Json[];
    };
    expect(tpl({ vcpu: 3, memoryMb: 100 })[0].limits).toEqual({ cpu: "4", memory: "2048Mi" });
    expect(tpl({ vcpu: 0.25, memoryMb: 64 })[0].limits).toEqual({ cpu: "250m", memory: "128Mi" });
    expect(tpl({ vcpu: 12, memoryMb: 512 })[0].limits).toEqual({ cpu: "8", memory: "4096Mi" });
    expect(() => tpl({ vcpu: 0 })).toThrow(GcpCompileError);
  });

  it("refuses artifacts without an immutable image reference (built/blueprint)", () => {
    for (const artifact of [{ type: "built", pipeline: "resource/pipeline" }, { type: "blueprint", blueprint: "next" }]) {
      const nodes = replaceSpec("service/web", { artifact });
      expect(() => fragmentFor("service/web", nodes)).toThrow(/image reference|resolved/);
    }
  });

  it("resolves secret env by dependency, accepts Secret Manager names, refuses orphan vault refs", () => {
    const direct = replaceSpec("service/web", { env: [{ key: "TOKEN", secretRef: "projects/acme-prod-123456/secrets/ext-token/versions/3" }] });
    const env = (((fragmentFor("service/web", direct).resource!.google_cloud_run_v2_service as Record<string, Json>).service_web.template as Json[])[0].containers as Json[])[0].env as Json[];
    expect(env[0].value_source).toEqual([{ secret_key_ref: [{ secret: "projects/acme-prod-123456/secrets/ext-token", version: "3" }] }]);
    const orphan = replaceSpec("service/web", { env: [{ key: "TOKEN", secretRef: "vault:ws_1/env_1/other" }] });
    expect(() => fragmentFor("service/web", orphan)).toThrow(/unresolved|nowhere/i);
  });

  it("refuses reserved, malformed and duplicate env names", () => {
    for (const env of [[{ key: "PORT", value: "1" }], [{ key: "K_SERVICE", value: "x" }], [{ key: "1BAD", value: "x" }], [{ key: "A", value: "1" }, { key: "A", value: "2" }]]) {
      expect(() => fragmentFor("service/web", replaceSpec("service/web", { env }))).toThrow(GcpCompileError);
    }
  });

  it("compiles a referenced service to a data source only", () => {
    const n = { ...environmentNodes().find((x) => x.address === "service/web")!, ownership: "referenced" as const, externalRef: `projects/${PROJECT}/locations/${REGION}/services/legacy-web` };
    const f = compileOne(n);
    expect(f.resource).toBeUndefined();
    expect(f.data).toEqual({ google_cloud_run_v2_service: { service_web: { name: "legacy-web", location: REGION } } });
    expect(f.addresses).toEqual(["data.google_cloud_run_v2_service.service_web"]);
  });
});

describe("cloud run job", () => {
  it("creates a scheduler job that can only run this job", () => {
    const frags = allFragments();
    const sched = ofType(frags, "google_cloud_scheduler_job")[0].body;
    expect(sched.schedule).toBe("0 3 * * *");
    expect(sched.time_zone).toBe("Etc/UTC");
    expect((sched.http_target as Json[])[0]).toMatchObject({ http_method: "POST", uri: "https://run.googleapis.com/v2/${google_cloud_run_v2_job.job_nightly.id}:run" });
    expect((((sched.http_target as Json[])[0]).oauth_token as Json[])[0].service_account_email).toBe("${google_service_account.job_nightly_sched.email}");
    const invoker = ofType(frags, "google_cloud_run_v2_job_iam_member")[0].body;
    expect(invoker).toMatchObject({ role: "roles/run.invoker", name: "${google_cloud_run_v2_job.job_nightly.name}" });
    expect(String(invoker.member)).toContain("job_nightly_sched");
  });

  it("compiles no scheduler when there is no schedule, and refuses non-cron schedules", () => {
    const none = replaceSpec("job/nightly", { schedule: undefined });
    expect(fragmentFor("job/nightly", none).addresses.some((a) => a.includes("scheduler"))).toBe(false);
    for (const schedule of ["rate(5 minutes)", "cron(0 3 * * ? *)", "0 3 * *", "0 3 * * * *", "every day"]) {
      expect(() => fragmentFor("job/nightly", replaceSpec("job/nightly", { schedule })), schedule).toThrow(/cron/);
    }
  });
});

describe("cloud sql", () => {
  const sqlBody = (patch: Json) => {
    const nodes = replaceSpec("resource/db", patch);
    return (fragmentFor("resource/db", nodes).resource!.google_sql_database_instance as Record<string, Json>).resource_db;
  };
  const settings = (b: Json) => (b.settings as Json[])[0];

  it("maps version, tier, HA and backups", () => {
    const b = sqlBody({});
    expect(b.database_version).toBe("POSTGRES_16");
    expect(settings(b).tier).toBe("db-custom-1-3840");
    expect(settings(b).availability_type).toBe("REGIONAL");
    expect(settings(b).backup_configuration).toEqual([{ backup_retention_settings: [{ retained_backups: 7, retention_unit: "COUNT" }], enabled: true, point_in_time_recovery_enabled: true, start_time: "03:00", transaction_log_retention_days: 7 }]);
    const off = sqlBody({ backup: "none", highAvailability: false, version: "15.4" });
    expect(off.database_version).toBe("POSTGRES_15");
    expect(settings(off).availability_type).toBe("ZONAL");
    expect(settings(off).backup_configuration).toEqual([{ enabled: false }]);
  });

  it("raises a shared-core tier when high availability is requested", () => {
    expect(settings(sqlBody({ size: "nano", highAvailability: true })).tier).toBe("db-custom-1-3840");
    expect(settings(sqlBody({ size: "nano", highAvailability: false })).tier).toBe("db-f1-micro");
    expect(settings(sqlBody({ instanceClass: "db-custom-8-32768" })).tier).toBe("db-custom-8-32768");
  });

  it("lifts deletion protection only for an explicit allow", () => {
    const allow = sqlBody({ deletionPolicy: "allow" });
    expect(allow.deletion_protection).toBe(false);
    expect(allow.deletion_policy).toBe("DELETE");
    expect(settings(allow).deletion_protection_enabled).toBe(false);
    for (const p of ["deny", "approval"]) expect(sqlBody({ deletionPolicy: p }).deletion_protection).toBe(true);
  });

  it("refuses unsupported versions, engines, tiers and a missing network", () => {
    for (const version of ["9", "8.0", "abc", "19", "16; drop"]) expect(() => sqlBody({ version }), version).toThrow(GcpCompileError);
    expect(() => sqlBody({ engine: "mysql" })).toThrow(/postgres only/);
    expect(() => sqlBody({ instanceClass: "evil tier" })).toThrow(GcpCompileError);
    const nodes = environmentNodes().map((n) => (n.address === "resource/db" ? { ...n, dependsOn: [] } : n));
    expect(() => fragmentFor("resource/db", nodes)).toThrow(/network/);
  });
});

describe("memorystore", () => {
  const redis = (patch: Json) => (fragmentFor("resource/cache", replaceSpec("resource/cache", patch)).resource!.google_redis_instance as Record<string, Json>).resource_cache;

  it("maps HA to STANDARD_HA, sizes to GB and backups to RDB snapshots", () => {
    expect(redis({}).tier).toBe("BASIC");
    expect(redis({ highAvailability: true }).tier).toBe("STANDARD_HA");
    expect(redis({}).persistence_config).toEqual([{ persistence_mode: "RDB", rdb_snapshot_period: "TWENTY_FOUR_HOURS" }]);
    expect(redis({ backup: "hourly" }).persistence_config).toEqual([{ persistence_mode: "RDB", rdb_snapshot_period: "ONE_HOUR" }]);
    expect(redis({ backup: "none" }).persistence_config).toBeUndefined();
    expect(redis({ size: "nano" }).memory_size_gb).toBe(1);
    expect(redis({ instanceClass: "memory-7gb" }).memory_size_gb).toBe(7);
    expect(() => redis({ instanceClass: "cache.m6g.large" })).toThrow(GcpCompileError);
  });
});

describe("storage bucket", () => {
  const bucket = (patch: Json) => (fragmentFor("resource/uploads", replaceSpec("resource/uploads", patch)).resource!.google_storage_bucket as Record<string, Json>).resource_uploads;

  it("adds noncurrent-version cleanup only with versioning, and keeps soft delete explicit", () => {
    expect(bucket({}).lifecycle_rule).toEqual([{ action: [{ type: "Delete" }], condition: [{ days_since_noncurrent_time: 30, with_state: "ARCHIVED" }] }]);
    expect(bucket({ versioning: false }).lifecycle_rule).toBeUndefined();
    expect(bucket({}).soft_delete_policy).toEqual([{ retention_duration_seconds: 604800 }]);
    expect(bucket({}).force_destroy).toBe(false);
  });

  it("protects from deletion unless explicitly allowed", () => {
    expect(bucket({}).deletion_policy).toBe("PREVENT");
    expect(bucket({ deletionPolicy: "allow" }).deletion_policy).toBe("DELETE");
  });
});

describe("pubsub", () => {
  it("a queue gets a dead-lettered pull subscription with the service agent bound at resource level", () => {
    const frags = allFragments();
    const f = frags.get("resource/jobs")!;
    expect(f.addresses[0]).toBe("google_pubsub_topic.resource_jobs");
    const sub = (f.resource!.google_pubsub_subscription as Record<string, Json>).resource_jobs_sub;
    expect(sub.dead_letter_policy).toEqual([{ dead_letter_topic: "${google_pubsub_topic.resource_jobs_dlq.id}", max_delivery_attempts: 5 }]);
    expect(sub.expiration_policy).toEqual([{ ttl: "" }]);
    const agent = "serviceAccount:service-${data.google_project.resource_jobs_project.number}@gcp-sa-pubsub.iam.gserviceaccount.com";
    expect((f.resource!.google_pubsub_topic_iam_member as Record<string, Json>).resource_jobs_dlq_publisher).toMatchObject({ member: agent, role: "roles/pubsub.publisher" });
    expect((f.resource!.google_pubsub_subscription_iam_member as Record<string, Json>).resource_jobs_dlq_subscriber).toMatchObject({ member: agent, role: "roles/pubsub.subscriber" });
  });

  it("a pubsub node is a single topic", () => {
    const f = allFragments().get("resource/events")!;
    expect(f.addresses).toEqual(["google_pubsub_topic.resource_events"]);
    expect(f.resource!.google_pubsub_subscription).toBeUndefined();
  });
});

describe("service account grants", () => {
  it("maps each grant to an exact-resource role", () => {
    const iam = resourcesOf(allFragments()).filter((r) => r.node === "identity/web" && r.type.endsWith("_iam_member"));
    const by = (type: string) => iam.filter((r) => r.type === type).map((r) => ({ role: r.body.role, target: r.body.bucket ?? r.body.topic ?? r.body.subscription ?? r.body.secret_id ?? r.body.repository ?? r.body.name }));
    expect(by("google_storage_bucket_iam_member")).toEqual(expect.arrayContaining([{ role: "roles/storage.objectViewer", target: "${google_storage_bucket.resource_uploads.name}" }, { role: "roles/storage.objectUser", target: "${google_storage_bucket.resource_uploads.name}" }]));
    expect(by("google_pubsub_topic_iam_member")).toEqual([{ role: "roles/pubsub.publisher", target: "${google_pubsub_topic.resource_jobs.name}" }]);
    expect(by("google_pubsub_subscription_iam_member")).toEqual([{ role: "roles/pubsub.subscriber", target: "${google_pubsub_subscription.resource_jobs_sub.name}" }]);
    expect(by("google_secret_manager_secret_iam_member")).toEqual([{ role: "roles/secretmanager.secretAccessor", target: "${google_secret_manager_secret.secret_api_key.secret_id}" }]);
    expect(by("google_artifact_registry_repository_iam_member")).toEqual([{ role: "roles/artifactregistry.reader", target: "${google_artifact_registry_repository.resource_registry.name}" }]);
    // redis grants compile no IAM binding; cloud sql gets two conditioned project bindings plus an IAM DB user
    expect(iam.some((r) => String(r.body.role).includes("redis"))).toBe(false);
    expect(iam.filter((r) => String(r.body.role).startsWith("roles/cloudsql"))).toHaveLength(2);
    expect(ofType(allFragments(), "google_sql_user")).toHaveLength(1);
  });

  it("refuses unknown verbs, unknown targets and targets it cannot grant on", () => {
    const grant = (g: Json) => replaceSpec("identity/web", { grants: [g] });
    for (const access of [["admin"], ["*"], ["delete_everything"], []]) {
      expect(() => fragmentFor("identity/web", grant({ target: "resource/uploads", access, via: [] })), JSON.stringify(access)).toThrow(GcpCompileError);
    }
    expect(() => fragmentFor("identity/web", grant({ target: "resource/missing", access: ["read"], via: [] }))).toThrow(/not in the graph/);
    expect(() => fragmentFor("identity/web", grant({ target: "network/main", access: ["read"], via: [] }))).toThrow(/not supported/);
    expect(() => fragmentFor("identity/web", grant({ target: "resource/events", access: ["consume"], via: [] }))).toThrow(GcpCompileError);
  });

  it("creates no service account keys and no primitive-role binding whatever the grants", () => {
    const nodes = replaceSpec("identity/web", {
      grants: environmentNodes().filter((n) => ["object_store", "secret", "queue", "container_registry"].includes(n.kind)).map((n) => ({ target: n.address, access: n.kind === "queue" ? ["publish"] : n.kind === "container_registry" ? ["pull"] : ["read"], via: [] })),
    });
    const json = JSON.stringify(fragmentFor("identity/web", nodes));
    expect(json).not.toContain("google_service_account_key");
    expect(json).not.toMatch(/roles\/(owner|editor|viewer)"/);
  });
});

describe("firewall rules", () => {
  it("expresses workload → database as a per-source egress allow to the database's private IP", () => {
    const frags = allFragments();
    const db = ofType(frags, "google_compute_firewall").find((r) => r.node === "firewall/web-to-db")!.body;
    expect(db).toMatchObject({ direction: "EGRESS", priority: 1000, allow: [{ protocol: "tcp", ports: ["5432"] }], destination_ranges: ["${google_sql_database_instance.resource_db.private_ip_address}/32"] });
    const webTag = ((((ofType(frags, "google_cloud_run_v2_service").find((r) => r.node === "service/web")!.body.template as Json[])[0].vpc_access as Json[])[0].network_interfaces as Json[])[0].tags as string[])[0];
    expect(db.target_tags).toEqual([webTag]);
    expect(db.source_tags).toBeUndefined();
    // the network-wide deny sits below it
    const deny = ofType(frags, "google_compute_firewall").find((r) => r.node === "network/main")!.body;
    expect(deny).toMatchObject({ direction: "EGRESS", priority: 2000, deny: [{ protocol: "all" }] });
    expect(Number(deny.priority)).toBeGreaterThan(Number(db.priority));
  });

  it("compiles public_http to nothing (the load balancer path is not governed by VPC firewalls)", () => {
    expect(allFragments().get("firewall/public")).toEqual({ addresses: [] });
  });

  it("refuses an open CIDR for anything but public_http, and malformed input", () => {
    const fw = (patch: Json, extraDeps: string[] = []) => {
      const base = mk("firewall/x", "firewall", { direction: "ingress", protocol: "tcp", port: 8080, source: { cidr: "10.0.0.0/8" }, target: "service/web", capability: "ops", description: "ops", ...patch }, ["network/main", ...extraDeps]);
      return compileOne(base);
    };
    const ok = fw({});
    expect(ofType(new Map([["x", ok]]), "google_compute_firewall")[0].body).toMatchObject({ direction: "INGRESS", source_ranges: ["10.0.0.0/8"] });
    expect(() => fw({ source: { cidr: "0.0.0.0/0" } })).toThrow(/open source/);
    expect(() => fw({ source: { cidr: "::/0" } })).toThrow(/open source/);
    expect(() => fw({ source: { cidr: "not-a-cidr" } })).toThrow(GcpCompileError);
    expect(() => fw({ port: 0 })).toThrow(GcpCompileError);
    expect(() => fw({ port: 70000 })).toThrow(GcpCompileError);
    expect(() => fw({ target: "resource/nope" })).toThrow(/not in the graph/);
    expect(() => fw({ source: { cidr: "10.0.0.0/8" }, target: "resource/db" })).toThrow(/CIDR source/);
  });
});

describe("load balancer, certificates and dns", () => {
  it("lists the primary forwarding rule first so ctx.ref resolves the IP, and wires hosts and paths", () => {
    const f = allFragments().get("load_balancer/public")!;
    expect(f.addresses[0]).toBe("google_compute_global_forwarding_rule.load_balancer_public");
    const fr = (f.resource!.google_compute_global_forwarding_rule as Record<string, Json>).load_balancer_public;
    expect(fr.port_range).toBe("443");
    expect(fr.load_balancing_scheme).toBe("EXTERNAL_MANAGED");
    const map = (f.resource!.google_compute_url_map as Record<string, Json>).load_balancer_public_urlmap;
    expect(map.host_rule).toEqual([{ hosts: ["app.example.com"], path_matcher: expect.stringMatching(/^pm-app-example-com-/) }]);
    const pm = (map.path_matcher as Json[])[0];
    expect(pm.path_rule).toEqual([{ paths: ["/worker", "/worker/*"], service: "${google_compute_backend_service.load_balancer_public_be_service_worker.id}" }]);
    expect(pm.default_service).toBe("${google_compute_backend_service.load_balancer_public_be_service_web.id}");
    const neg = Object.values(f.resource!.google_compute_region_network_endpoint_group as Record<string, Json>);
    expect(neg.every((n) => n.network_endpoint_type === "SERVERLESS")).toBe(true);
    expect(neg.map((n) => (n.cloud_run as Json[])[0].service).sort()).toEqual(["${google_cloud_run_v2_service.service_web.name}", "${google_cloud_run_v2_service.service_worker.name}"]);
    const cert = (f.resource!.google_compute_target_https_proxy as Record<string, Json>).load_balancer_public_https_proxy_443.ssl_certificates;
    expect(cert).toEqual(["${google_compute_managed_ssl_certificate.tls_certificate_app_example_com.id}"]);
  });

  it("the DNS record points at the load balancer's reserved IP as an A record", () => {
    const rec = ofType(allFragments(), "google_dns_record_set")[0].body;
    expect(rec).toMatchObject({ type: "A", ttl: 300, name: "app.example.com.", rrdatas: ["${google_compute_global_forwarding_rule.load_balancer_public.ip_address}"], managed_zone: "${google_dns_managed_zone.dns_zone_example_com.name}" });
  });

  it("the certificate name changes with the domain and is created before the old one is destroyed", () => {
    const c = (domain: string) => ofType(fragmentFor("tls_certificate/app.example.com", replaceSpec("tls_certificate/app.example.com", { domain })) ? new Map([["c", fragmentFor("tls_certificate/app.example.com", replaceSpec("tls_certificate/app.example.com", { domain }))]]) : new Map(), "google_compute_managed_ssl_certificate")[0].body;
    expect(c("a.example.com").name).not.toBe(c("b.example.com").name);
    expect(c("a.example.com").lifecycle).toEqual({ create_before_destroy: true });
    expect(c("A.Example.com.").managed).toEqual([{ domains: ["a.example.com"] }]);
  });

  it("refuses inconsistent load balancers", () => {
    const lb = (patch: Json, nodes = environmentNodes()) => fragmentFor("load_balancer/public", replaceSpec("load_balancer/public", patch, nodes));
    expect(() => lb({ routes: [] })).toThrow(/route/);
    expect(() => lb({ listeners: [] })).toThrow(/listener/);
    expect(() => lb({ listeners: [{ port: 9000, protocol: "https" }] })).toThrow(/443 or 8443/);
    expect(() => lb({ listeners: [{ port: 443, protocol: "https" }, { port: 443, protocol: "https" }] })).toThrow(/same port/);
    expect(() => lb({ routes: [{ host: "app.example.com", pathPrefix: "/", tls: true, target: "service/web" }, { host: "app.example.com", pathPrefix: "/", tls: true, target: "service/worker" }] })).toThrow(/twice/);
    expect(() => lb({ routes: [{ host: "app.example.com", pathPrefix: "/a*", tls: true, target: "service/web" }] })).toThrow(/wildcard|start with/);
    expect(() => lb({ routes: [{ host: "app.example.com", pathPrefix: "/", tls: true, target: "service/ghost" }] })).toThrow(/not in the graph/);
    const noCert = environmentNodes().map((n) => (n.address === "load_balancer/public" ? { ...n, dependsOn: ["service/web", "service/worker"] } : n));
    expect(() => lb({}, noCert)).toThrow(/tls_certificate/);
  });

  it("refuses to alias anything but a load balancer", () => {
    const nodes = environmentNodes().map((n) => (n.address === "dns_record/app.example.com" ? { ...n, spec: { ...n.spec, target: "service/web" } } : n));
    expect(() => fragmentFor("dns_record/app.example.com", nodes)).toThrow(/only a load balancer/);
  });

  it("an http-only load balancer needs no certificate and serves the main URL map", () => {
    const nodes = environmentNodes().map((n) => (n.address === "load_balancer/public" ? { ...n, dependsOn: ["service/web", "service/worker"], spec: { ...n.spec, listeners: [{ port: 80, protocol: "http" }] } } : n));
    const f = fragmentFor("load_balancer/public", nodes);
    expect(f.resource!.google_compute_ssl_policy).toBeUndefined();
    expect((f.resource!.google_compute_target_http_proxy as Record<string, Json>).load_balancer_public_http_proxy_80.url_map).toBe("${google_compute_url_map.load_balancer_public_urlmap.id}");
  });
});

describe("network and subnets", () => {
  it("creates NAT only when asked and always the PSA connection", () => {
    const f = allFragments().get("network/main")!;
    expect(f.addresses).toEqual(expect.arrayContaining(["google_compute_router.network_main_router", "google_compute_router_nat.network_main_nat", "google_service_networking_connection.network_main_psa"]));
    const none = replaceSpec("network/main", { egress: { natGateways: "none" } });
    const g = fragmentFor("network/main", none);
    expect(g.addresses.some((a) => a.includes("router"))).toBe(false);
    expect(g.addresses).toContain("google_service_networking_connection.network_main_psa");
  });

  it("subnets are regional, private tier has Private Google Access, bad CIDRs are refused", () => {
    const frags = allFragments();
    const priv = (frags.get("subnet/private-a")!.resource!.google_compute_subnetwork as Record<string, Json>).subnet_private_a;
    expect(priv).toMatchObject({ region: REGION, ip_cidr_range: "10.20.1.0/24", private_ip_google_access: true, network: "${google_compute_network.network_main.id}" });
    const pub = (frags.get("subnet/public-a")!.resource!.google_compute_subnetwork as Record<string, Json>).subnet_public_a;
    expect(pub.private_ip_google_access).toBe(false);
    expect(() => fragmentFor("subnet/private-a", replaceSpec("subnet/private-a", { cidr: "10.0.0.0/4" }))).toThrow(GcpCompileError);
    expect(() => fragmentFor("subnet/private-a", replaceSpec("subnet/private-a", { cidr: "evil" }))).toThrow(GcpCompileError);
  });
});

describe("build pipeline and registry", () => {
  it("compiles a private source bucket, a least-privilege build account and the registry push binding", () => {
    const frags = allFragments();
    const f = frags.get("resource/pipeline")!;
    expect(f.addresses[0]).toBe("google_storage_bucket.resource_pipeline");
    const bucket = (f.resource!.google_storage_bucket as Record<string, Json>).resource_pipeline;
    expect(bucket).toMatchObject({ public_access_prevention: "enforced", uniform_bucket_level_access: true, force_destroy: true });
    expect(bucket.lifecycle_rule).toEqual([{ action: [{ type: "Delete" }], condition: [{ age: 7 }] }]);
    const writer = (f.resource!.google_artifact_registry_repository_iam_member as Record<string, Json>).resource_pipeline_registry_writer;
    expect(writer).toMatchObject({ role: "roles/artifactregistry.writer", repository: "${google_artifact_registry_repository.resource_registry.name}" });
    expect(Object.keys(f.output ?? {}).sort()).toEqual(["resource_pipeline_build_service_account", "resource_pipeline_source_bucket"]);
    expect(JSON.stringify(f)).not.toContain("google_cloudbuild_trigger");
  });

  it("refuses static-site output and unknown registries", () => {
    expect(() => fragmentFor("resource/pipeline", replaceSpec("resource/pipeline", { output: { staticSite: "site/x" } }))).toThrow(/container registry/);
    expect(() => fragmentFor("resource/pipeline", replaceSpec("resource/pipeline", { output: { registry: "resource/ghost" } }))).toThrow(/not in the graph/);
  });

  it("registry is a docker repository with mutable tags and inherited scanning", () => {
    const repo = (allFragments().get("resource/registry")!.resource!.google_artifact_registry_repository as Record<string, Json>).resource_registry;
    expect(repo).toMatchObject({ format: "DOCKER", docker_config: [{ immutable_tags: false }], vulnerability_scanning_config: [{ enablement_config: "INHERITED" }] });
  });
});

describe("referenced nodes compile to data sources only", () => {
  it("every driver that can be referenced emits data, never resources, and the assembler accepts it", () => {
    const refs: [string, Partial<ResourceNode>][] = [
      ["network/main", { externalRef: `projects/${PROJECT}/global/networks/legacy` }],
      ["subnet/private-a", { externalRef: `projects/${PROJECT}/regions/${REGION}/subnetworks/legacy` }],
      ["identity/web", { externalRef: `projects/${PROJECT}/serviceAccounts/legacy@${PROJECT}.iam.gserviceaccount.com` }],
      ["resource/db", { externalRef: `projects/${PROJECT}/instances/legacy` }],
      ["resource/cache", { externalRef: `projects/${PROJECT}/locations/${REGION}/instances/legacy` }],
      ["resource/uploads", { externalRef: "legacy-bucket" }],
      ["resource/jobs", { externalRef: `projects/${PROJECT}/topics/legacy` }],
      ["secret/api-key", { externalRef: `projects/${PROJECT}/secrets/legacy` }],
      ["resource/registry", { externalRef: `projects/${PROJECT}/locations/${REGION}/repositories/legacy` }],
      ["job/nightly", { externalRef: `projects/${PROJECT}/locations/${REGION}/jobs/legacy` }],
      ["dns_zone/example.com", { externalRef: `projects/${PROJECT}/managedZones/legacy` }],
      ["dns_record/app.example.com", { externalRef: `projects/${PROJECT}/managedZones/legacy/rrsets/app.example.com./A` }],
      ["tls_certificate/app.example.com", { externalRef: `projects/${PROJECT}/global/sslCertificates/legacy` }],
    ];
    const nodes = environmentNodes().map((n) => {
      const r = refs.find(([a]) => a === n.address);
      return r ? { ...n, ownership: "referenced" as const, ...r[1] } : n;
    });
    const frags = compileContext(nodes).compileAll();
    for (const [a] of refs) {
      const f = frags.get(a)!;
      expect(f.resource, a).toBeUndefined();
      expect(f.addresses.every((x) => x.startsWith("data.")), a).toBe(true);
    }
    expect(() => assembleWorkspace({ graph: graphOf(nodes), fragments: frags, providerSet: "gcp", region: REGION, backend: { kind: "local" }, tags: TAGS })).not.toThrow();
  });
});
