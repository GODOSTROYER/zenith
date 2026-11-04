/**
 * Static security checks over everything the OCI drivers compile, for several
 * environments, plus the customer bootstrap module. These are the invariants a
 * reviewer would grep for; they run on the compiled JSON, not on the source.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Manifest } from "@/lib/domain/types";
import { assembleWorkspace } from "@/lib/tofu/workspace";
import { allResources, compileGraph, compiledNodes, expandOci, nodeOf, OCI_PROD, resourcesOf, webStack, type CompiledGraph } from "./_support";

function variants(): { name: string; compiled: CompiledGraph }[] {
  const worker: Manifest = webStack();
  const canary: Manifest = webStack();
  canary.services[0].env.push({ key: "API_TOKEN", secretRef: "vault:CANARY_REF_9d41", value: "CANARY_VALUE_8f2c1b" } as never);
  return [
    { name: "staging", compiled: compileGraph(expandOci(worker)) },
    { name: "production", compiled: compileGraph(expandOci(worker, OCI_PROD)) },
    { name: "canary", compiled: compileGraph(expandOci(canary)) },
  ];
}
const VARIANTS = variants();

const json = (c: CompiledGraph): string => JSON.stringify([...c.fragments.values()]);

/** Paths whose KEY names a credential and whose value is a literal (not a `${…}` reference). */
function plaintextOffenders(v: unknown, where: string): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => plaintextOffenders(x, `${where}[${i}]`));
  if (v && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => [
      ...(/^(password|private_key|private_key_pem|passphrase|client_secret|api_key|secret_key|token|content)$/i.test(k) && typeof x === "string" && !x.startsWith("${") ? [`${where}.${k}`] : []),
      ...plaintextOffenders(x, `${where}.${k}`),
    ]);
  }
  return [];
}

describe("the detectors have teeth", () => {
  it("plaintextOffenders flags a literal password, key and secret content, and ignores references", () => {
    expect(plaintextOffenders({ credentials: { password_details: { password: "hunter2", password_type: "PLAIN_TEXT" } }, secret_content: { content: "c2VjcmV0" }, a: { private_key: "-----BEGIN" } }, "x").sort()).toEqual(["x.a.private_key", "x.credentials.password_details.password", "x.secret_content.content"]);
    expect(plaintextOffenders({ password: "${oci_vault_secret.x.id}" }, "x")).toEqual([]);
  });
});

describe.each(VARIANTS)("compiled output: $name", ({ compiled }) => {
  it("nothing was refused", () => {
    expect([...compiled.refused]).toEqual([]);
  });

  it("fragments only use the keys a driver may emit; no provisioners, connections or filesystem reads", () => {
    for (const f of compiled.fragments.values()) {
      expect(Object.keys(f).every((k) => ["resource", "data", "output", "locals", "addresses"].includes(k))).toBe(true);
    }
    expect(json(compiled)).not.toMatch(/"provisioner"|"connection"|\bfile\(|templatefile\(|path\.module|"local-exec"/);
  });

  it("no bucket, repository or load balancer is public by accident; no instance gets a public IP", () => {
    for (const r of allResources(compiled)) {
      if (r.type === "oci_objectstorage_bucket") expect(r.body.access_type, r.node).toBe("NoPublicAccess");
      if (r.type === "oci_artifacts_container_repository") expect(r.body.is_public, r.node).toBe(false);
      if (r.type === "oci_container_instances_container_instance") for (const v of r.body.vnics as { is_public_ip_assigned: boolean }[]) expect(v.is_public_ip_assigned).toBe(false);
      if (r.type === "oci_load_balancer_load_balancer") expect(r.body.is_private).toBe(false); // the one public thing, by design
      if (r.type === "oci_core_subnet" && /private/.test(r.node)) expect(r.body).toMatchObject({ prohibit_public_ip_on_vnic: true, prohibit_internet_ingress: true });
      if (r.type === "oci_psql_db_system") expect(JSON.stringify(r.body)).not.toMatch(/public/i);
    }
  });

  it("no plaintext password, key or token argument exists anywhere", () => {
    const offenders: string[] = [];
    for (const r of allResources(compiled)) offenders.push(...plaintextOffenders(r.body, `${r.node}:${r.type}.${r.name}`));
    expect(offenders).toEqual([]);
    for (const r of allResources(compiled).filter((x) => x.type === "oci_psql_db_system")) {
      expect((r.body.credentials as { password_details: { password_type: string } }).password_details.password_type).toBe("VAULT_SECRET");
    }
    for (const r of allResources(compiled).filter((x) => x.type === "oci_vault_secret")) expect(r.body.secret_content).toBeUndefined();
  });

  it("no statement or rule says all-resources, and no wildcard is granted", () => {
    const text = json(compiled);
    expect(text).not.toMatch(/all-resources/i);
    for (const r of allResources(compiled).filter((x) => x.type === "oci_identity_policy")) {
      for (const s of r.body.statements as string[]) {
        expect(s).toMatch(/^Allow dynamic-group \$\{oci_identity_dynamic_group\.[a-z0-9_]+\.name\} to (inspect|read|use|manage) [a-z-]+ in compartment id ocid1\.compartment\./);
        expect(s, "every workload statement names its target").toMatch(/ where target\.[a-z.]+ = '[^'*]+'$/);
        expect(s).not.toContain("*");
        expect(s).not.toMatch(/tenancy|any-user/);
      }
    }
  });

  it("only the public_http rules into the load balancer admit the world; the subnet lists admit nobody", () => {
    const open: string[] = [];
    for (const r of allResources(compiled)) {
      if (r.type === "oci_core_security_list" || r.type === "oci_core_default_security_list") expect(r.body.ingress_security_rules, r.node).toBeUndefined();
      if (r.type !== "oci_core_network_security_group_security_rule") continue;
      const node = nodeOf(compiled.graph, r.node);
      const spec = node.spec as { source: { cidr?: string }; capability: string; target: string };
      if (r.body.source_type === "CIDR_BLOCK" && /^(0\.0\.0\.0\/0|::\/0)$/.test(String(r.body.source))) {
        open.push(r.node);
        expect(spec.capability, r.node).toBe("public_http");
        expect(nodeOf(compiled.graph, spec.target).nativeType, r.node).toBe("oci:load_balancer");
      } else {
        // every other rule is NSG-to-NSG or a narrow private CIDR
        expect(r.body.source_type, r.node).toBe("NETWORK_SECURITY_GROUP");
      }
      expect(r.body.direction).toBe("INGRESS");
      expect(r.body.protocol).toBe("6");
    }
    expect(open.sort()).toEqual(["firewall/internet-to-lb-443", "firewall/internet-to-lb-80"]);
  });

  it("stateful resources are protected from destroy unless the spec allowed deletion", () => {
    const stateful = new Set(["oci_psql_db_system", "oci_objectstorage_bucket", "oci_queue_queue", "oci_redis_redis_cluster", "oci_core_volume"]);
    for (const r of allResources(compiled).filter((x) => stateful.has(x.type))) expect(r.body.lifecycle, `${r.node} ${r.type}`).toEqual({ prevent_destroy: true });
  });

  it("the TLS floor is 1.2 and the certificate is referenced, never embedded", () => {
    const text = json(compiled);
    expect(text).not.toMatch(/TLSv1\.0|TLSv1\.1|"TLSv1"|BEGIN CERTIFICATE|BEGIN [A-Z ]*PRIVATE KEY/);
    for (const r of allResources(compiled).filter((x) => x.type === "oci_load_balancer_listener" && x.body.ssl_configuration)) {
      expect((r.body.ssl_configuration as { protocols: string[] }).protocols).toEqual(["TLSv1.2", "TLSv1.3"]);
    }
  });

  it("assembles into a pinned OCI workspace without the assembler objecting", () => {
    const nodes = compiledNodes(compiled);
    const ws = assembleWorkspace({
      graph: { ...compiled.graph, nodes },
      fragments: compiled.fragments,
      providerSet: "oci",
      region: "us-ashburn-1",
      backend: { kind: "local" },
      tags: {},
      providerConfig: { oci: { auth: "InstancePrincipal" } },
    });
    const providers = JSON.parse(ws.files.find((f) => f.path === "providers.tf.json")!.content);
    expect(providers.provider.oci).toEqual({ auth: "InstancePrincipal", region: "us-ashburn-1" });
    expect(ws.files.map((f) => f.content).join("\n")).not.toMatch(/ocid1\.user\.|fingerprint|private_key/i);
  });
});

describe("secret canaries", () => {
  const canary = VARIANTS.find((v) => v.name === "canary")!.compiled;

  it("a secretRef never leaks its reference or the value that sat next to it", () => {
    const text = json(canary);
    expect(text).not.toContain("CANARY_VALUE_8f2c1b");
    expect(text).not.toContain("CANARY_REF_9d41");
    const env = (resourcesOf(canary.fragments.get("container_service/web")!).find((r) => r.type === "oci_container_instances_container_instance")!.body.containers as { environment_variables: Record<string, string> }[])[0].environment_variables;
    expect(env.API_TOKEN).toBeUndefined();
    expect(Object.keys(env).filter((k) => /^ZENITH_SECRET_OCID_/.test(k))).toContain("ZENITH_SECRET_OCID_API_TOKEN");
  });

  it("an inline credential-looking value is kept as authored (the manifest is the user's) but the driver adds no other secret", () => {
    const m = webStack();
    m.services[0].env.push({ key: "DB_PASSWORD", value: "authored-inline-value" });
    const c = compileGraph(expandOci(m));
    const env = (resourcesOf(c.fragments.get("container_service/web")!).find((r) => r.type === "oci_container_instances_container_instance")!.body.containers as { environment_variables: Record<string, string> }[])[0].environment_variables;
    expect(env.DB_PASSWORD).toBe("authored-inline-value");
    // and nothing else in the workspace repeats it
    expect(JSON.stringify([...c.fragments.entries()].filter(([a]) => a !== "container_service/web")).includes("authored-inline-value")).toBe(false);
  });
});

describe("customer bootstrap module (deploy/oci)", () => {
  const dir = path.join(process.cwd(), "deploy", "oci");
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
  const tf = ["versions.tf", "variables.tf", "main.tf", "outputs.tf"].map(read).join("\n");

  it("pins OpenTofu-compatible provider versions exactly like the platform and ships the lock", () => {
    expect(read("versions.tf")).toContain('version = "= 9.7.1"');
    expect(read(".terraform.lock.hcl")).toMatch(/registry\.opentofu\.org\/oracle\/oci"[\s\S]*version\s*=\s*"9\.7\.1"/);
    expect(read(".terraform.lock.hcl")).not.toContain("hashicorp/random");
  });

  it("never grants all-resources, secret-bundles, user/group/compartment management or object-level access", () => {
    const codeOnly = tf.replace(/#[^\n]*/g, "");
    expect(codeOnly).not.toMatch(/all-resources|secret-bundles|secret-family|manage (users|groups|compartments|tenancy|objects|object-family)/);
    expect(codeOnly).not.toMatch(/oci_identity_(user|group|api_key|customer_secret_key|auth_token|smtp_credential)\b/);
  });

  it("scopes every compartment grant to the Zenith compartment and keeps tenancy grants to the three it needs", () => {
    const grants = [...tf.matchAll(/^\s+"((?:manage|use|read|inspect) [a-z-]+)",?$/gm)].map((m) => m[1]);
    expect(grants.length).toBeGreaterThan(15);
    expect(tf).toContain('in compartment id ${local.c}');
    const tenancy = [...tf.matchAll(/in tenancy/g)].length;
    expect(tenancy).toBeLessThanOrEqual(6);
    for (const line of tf.split("\n").filter((l) => l.includes("in tenancy"))) {
      expect(line).toMatch(/objectstorage-namespaces|dynamic-groups/);
    }
    expect(grants.filter((g) => g.startsWith("manage ")).every((g) => !/all|family$/.test(g) || /^manage (virtual-network|compute-container|redis)-family$/.test(g))).toBe(true);
  });

  it("creates a private, versioned state bucket and a vault + key under the names the drivers look up", () => {
    expect(read("main.tf")).toMatch(/access_type\s*=\s*"NoPublicAccess"/);
    expect(read("main.tf")).toMatch(/versioning\s*=\s*"Enabled"/);
    expect(read("main.tf")).toContain('display_name   = "zenith-vault"');
    expect(read("main.tf")).toContain('display_name        = "zenith-secrets-key"');
  });

  it("validates identifiers it splices into dynamic group rules", () => {
    expect(read("variables.tf")).toMatch(/can\(regex\("\^ocid1\\\\\.instance/);
    expect(read("variables.tf")).toMatch(/can\(regex\("\^ocid1\\\\\.computecontainerinstance/);
  });

  it("the README states what it does not do", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/no user, no API key, no customer secret key/);
    expect(readme).toMatch(/not\s+been applied to a tenancy|has \*\*not\*\*\s+been applied/);
    expect(readme).toMatch(/never read one back/);
  });
});
