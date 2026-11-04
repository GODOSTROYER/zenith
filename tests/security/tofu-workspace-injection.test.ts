/**
 * OpenTofu workspace assembly under hostile strings (WS-SEC).
 *
 * `assembleWorkspace` (src/lib/tofu/workspace.ts) is the trust boundary between
 * "strings derived from a manifest, a repository or a cloud response" and "a
 * configuration a runner executes with real credentials". Its own header says
 * so. This file attacks that boundary with the shared injection corpus, in two
 * ways:
 *
 *  1. STRUCTURAL: whatever string is planted in an attribute, output, local,
 *     tag or label, the assembled files are valid JSON, contain no
 *     provisioner/connection/remote-exec anywhere, keep the same four files and
 *     the same top-level keys, and the string appears only where it was put.
 *  2. SEMANTIC (real OpenTofu 1.12.5, builtin provider, no network): a string
 *     the assembler ACCEPTS must not make tofu read a file, enumerate a
 *     directory, leak the runner's path, or unmask a sensitive value. Tofu is
 *     the only judge of what an HCL template does; a regex is only a guess.
 *
 * Findings proven here (each has an `it.fails`; flip to `it` when fixed):
 *   SEC-F5 (HIGH)   the forbidden-call scan is a regex for `file(`; a comment
 *                   between the name and the parenthesis (`file/*x*\/("...")`,
 *                   or `#`/`//` line comments) passes it and tofu evaluates it.
 *                   Path references written `path . cwd` / `path/**\/.cwd` leak
 *                   the runner's directory the same way.
 *   SEC-F4 (MEDIUM) `nonsensitive()` is not forbidden: a fragment can unmask a
 *                   value tofu marked sensitive, so it reaches `planView`.
 *   SEC-F3 (MEDIUM, latent) `providerConfig` accepts `endpoints`, `http_proxy`,
 *                   `custom_ca_bundle`, `insecure`, `assume_role` …: a provider
 *                   configuration that can redirect or weaken the API traffic
 *                   that carries the brokered credentials.
 *   SEC-F2 (LOW)    a resource/output/local named `__proto__` is accepted by the
 *                   label rule and then silently dropped from main.tf.json
 *                   while `addressMap` still claims it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { planWorkspace } from "@/lib/tofu/engine";
import { TofuCommandError, TofuRunner } from "@/lib/tofu/runner";
import type { TofuWorkspace } from "@/lib/tofu/types";
import { assembleWorkspace, assertWorkspaceIntact, TofuWorkspaceError, type AssembleWorkspaceInput } from "@/lib/tofu/workspace";
import { builtinWorkspace, dataFragment, graphOf, node, tofuOnPath } from "../tofu/_helpers";
import { injectionsFor, SMALL_CATEGORIES, type InjectionCase } from "../_support/security";

const hasTofu = tofuOnPath();
const STATE = path.join(os.tmpdir(), "zenith-sec-state", "terraform.tfstate");

/* ------------------------------ tree utilities ------------------------------ */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function walkStrings(value: Json, at: string, visit: (s: string, where: string, isKey: boolean) => void): void {
  if (typeof value === "string") return visit(value, at, false);
  if (Array.isArray(value)) return value.forEach((v, i) => walkStrings(v, `${at}[${i}]`, visit));
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      visit(k, `${at}.<key:${k.slice(0, 20)}>`, true);
      walkStrings(v, `${at}.${k}`, visit);
    }
  }
}

function walkKeys(value: Json, visit: (key: string, at: string) => void, at = "$"): void {
  if (Array.isArray(value)) return value.forEach((v, i) => walkKeys(v, visit, `${at}[${i}]`));
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      visit(k, `${at}.${k}`);
      walkKeys(v, visit, `${at}.${k}`);
    }
  }
}

const EXPECTED_FILES = ["backend.tf.json", "main.tf.json", "providers.tf.json", "versions.tf.json"];
const COMMAND_KEYS = new Set(["provisioner", "connection", "local-exec", "remote-exec", "external", "program"]);

/** What must hold for EVERY accepted workspace, whatever strings went into it. */
function assertStructurallyInert(ws: TofuWorkspace, planted: string, label: string): void {
  expect(ws.files.map((f) => f.path).sort(), `${label}: the set of files must not change`).toEqual(EXPECTED_FILES);
  assertWorkspaceIntact(ws); // digests recompute from the bytes
  for (const f of ws.files) {
    let parsed: Json;
    try {
      parsed = JSON.parse(f.content) as Json;
    } catch (e) {
      throw new Error(`SECURITY INVARIANT VIOLATED: ${label}: ${f.path} is no longer valid JSON after planting an injection string (${(e as Error).message})`);
    }
    walkKeys(parsed, (key, at) => {
      if (COMMAND_KEYS.has(key)) throw new Error(`SECURITY INVARIANT VIOLATED: ${label}: ${f.path} contains a "${key}" key at ${at}; injection created a command-running construct`);
    });
    if (f.path === "main.tf.json") {
      const top = Object.keys(parsed as object);
      expect(top.every((k) => ["data", "locals", "output", "resource"].includes(k)), `${label}: unexpected top-level key in main.tf.json: ${top.join(",")}`).toBe(true);
    }
    if (f.path === "versions.tf.json" || f.path === "backend.tf.json") {
      walkStrings(parsed, "$", (s, where) => {
        if (planted.length >= 8 && s.includes(planted)) throw new Error(`SECURITY INVARIANT VIOLATED: ${label}: planted string reached ${f.path} at ${where}`);
      });
    }
  }
}

const accepted: string[] = [];
const refusedBy = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    if (e instanceof TofuWorkspaceError) return e.code;
    throw e;
  }
};

/* ---------------------------------- part 1 ---------------------------------- */

const corpus = (): InjectionCase[] => injectionsFor(...SMALL_CATEGORIES);

describe("assembleWorkspace: a hostile string planted as a VALUE yields a structurally inert workspace", () => {
  type Place = { name: string; fragment: (s: string) => TofuFragment; providerTags?: boolean };
  const places: Place[] = [
    { name: "resource attribute", fragment: (s) => dataFragment("a", s) },
    { name: "deeply nested attribute", fragment: (s) => dataFragment("a", { a: [{ b: { c: [s] } }] }) },
    { name: "attribute NAME (object key)", fragment: (s) => dataFragment("a", { [s]: 1 }) },
    { name: "output value", fragment: (s) => ({ ...dataFragment("a", "x"), output: { o: { value: s } } }) },
    { name: "local value", fragment: (s) => ({ ...dataFragment("a", "x"), locals: { l: s } }) },
    { name: "description of an output", fragment: (s) => ({ ...dataFragment("a", "x"), output: { o: { value: "x", description: s } } }) },
  ];

  for (const place of places) {
    it(`${place.name}: every corpus string is refused or inert`, () => {
      for (const c of corpus()) {
        const label = `${place.name} <- ${c.id}`;
        let ws: TofuWorkspace | undefined;
        const code = refusedBy(() => {
          ws = builtinWorkspace(STATE, { "resource/a": place.fragment(c.value) });
        });
        if (code) {
          expect(["forbidden_construct", "invalid_fragment", "invalid_input"], `${label}: refused with an unexpected code ${code}`).toContain(code);
          continue;
        }
        accepted.push(c.id);
        assertStructurallyInert(ws!, c.value, label);
      }
    });
  }

  it("a string planted in a provider tag or a tag key is refused or inert", () => {
    for (const c of corpus()) {
      const label = `tags <- ${c.id}`;
      for (const tags of [{ team: c.value }, { [c.value]: "x" }]) {
        let ws: TofuWorkspace | undefined;
        const code = refusedBy(() => {
          ws = builtinWorkspace(STATE, { "resource/a": dataFragment("a", "x") }, { tags });
        });
        if (!code) assertStructurallyInert(ws!, c.value, label);
      }
    }
  });

  it("the oversized strings are either refused or fit the 8 MiB file bound (no unbounded write)", () => {
    for (const c of injectionsFor("oversized")) {
      const code = refusedBy(() => {
        const ws = builtinWorkspace(STATE, { "resource/a": dataFragment("a", c.value.slice(0, 2_000_000)) });
        for (const f of ws.files) expect(Buffer.byteLength(f.content)).toBeLessThanOrEqual(8 * 1024 * 1024);
      });
      expect(code === undefined || code === "invalid_input", c.id).toBe(true);
    }
  });

  it("accepted a meaningful number of corpus strings (the matrix is not passing by refusing everything)", () => {
    expect(accepted.length).toBeGreaterThan(200);
  });
});

/* ---------------------------------- part 2 ---------------------------------- */

describe("assembleWorkspace: hostile LABELS and backend fields are refused", () => {
  const labelPlacements: [string, (s: string) => TofuFragment][] = [
    ["resource label", (s) => ({ resource: { terraform_data: { [s]: { input: "x" } } }, addresses: [`terraform_data.${s}`] })],
    ["resource type", (s) => ({ resource: { [s]: { a: { input: "x" } } }, addresses: [`${s}.a`] })],
    ["output name", (s) => ({ ...dataFragment("a", "x"), output: { [s]: { value: "x" } } })],
    ["local name", (s) => ({ ...dataFragment("a", "x"), locals: { [s]: "x" } })],
    ["fragment top-level key", (s) => ({ ...dataFragment("a", "x"), [s]: {} }) as TofuFragment],
  ];

  for (const [name, build] of labelPlacements) {
    it(`${name}: no corpus string gets through unless it is a plain identifier`, () => {
      for (const c of corpus()) {
        const code = refusedBy(() => builtinWorkspace(STATE, { "resource/a": build(c.value) }));
        expect(code, `${name} <- ${c.id} must be refused as an invalid label`).toBeDefined();
      }
    });
  }

  it("the node address is only ever a map key: an unknown or hostile address is refused", () => {
    for (const c of corpus()) {
      const graph = graphOf([node("resource/a")]);
      const code = refusedBy(() =>
        assembleWorkspace({ graph, fragments: new Map([[c.value, dataFragment("a", "x")]]), providerSet: "builtin", region: "ap-south-1", backend: { kind: "local", path: STATE }, tags: {} })
      );
      expect(code, `node address <- ${c.id}`).toBe("unknown_node");
    }
  });

  it("backend and region fields: bucket, state key, region and KMS ids reject every corpus string", () => {
    const base = (over: Partial<AssembleWorkspaceInput>): AssembleWorkspaceInput => ({
      graph: graphOf([node("resource/a")]),
      fragments: new Map([["resource/a", dataFragment("a", "x")]]),
      providerSet: "builtin",
      region: "ap-south-1",
      backend: { kind: "local", path: STATE },
      tags: {},
      ...over,
    });
    for (const c of corpus()) {
      expect(refusedBy(() => assembleWorkspace(base({ region: c.value }))), `region <- ${c.id}`).toBeDefined();
      expect(refusedBy(() => assembleWorkspace(base({ backend: { kind: "s3", bucket: c.value }, stateKey: "zenith/ws/env/terraform.tfstate" }))), `bucket <- ${c.id}`).toBeDefined();
      // an S3 key may legitimately be plain text (`data.terraform_remote_state.x` is a valid key); what must hold
      // is that anything accepted is made of the safe alphabet, cannot climb (`..`) or be absolute, and stays in one JSON string
      const keyCode = refusedBy(() => {
        const ws = assembleWorkspace(base({ backend: { kind: "s3", bucket: "state-bucket-1" }, stateKey: c.value }));
        const key = (JSON.parse(ws.files.find((f) => f.path === "backend.tf.json")!.content) as { terraform: { backend: { s3: { key: string } } } }).terraform.backend.s3.key;
        expect(key, `stateKey <- ${c.id} must round-trip unchanged`).toBe(c.value);
        expect(key, `stateKey <- ${c.id}: accepted key outside the safe alphabet`).toMatch(/^[A-Za-z0-9!_.*'()/=+@:-]+$/);
        expect(key.includes("..") || key.startsWith("/"), `stateKey <- ${c.id}: traversal accepted`).toBe(false);
      });
      if (keyCode !== undefined) expect(keyCode, `stateKey <- ${c.id}`).toBe("invalid_input");
      expect(refusedBy(() => assembleWorkspace(base({ backend: { kind: "s3", bucket: "state-bucket-1", sseKmsKeyId: c.value }, stateKey: "zenith/k" }))), `kms key id <- ${c.id}`).toBeDefined();
      expect(refusedBy(() => assembleWorkspace(base({ backend: { kind: "s3", bucket: "state-bucket-1", encryptionKmsKeyArn: c.value }, stateKey: "zenith/k" }))), `kms arn <- ${c.id}`).toBeDefined();
    }
  });

  it("an http state backend must be https without userinfo; the corpus URLs are refused or https", () => {
    for (const c of injectionsFor("url", "header-injection")) {
      const code = refusedBy(() =>
        assembleWorkspace({
          graph: graphOf([node("resource/a")]),
          fragments: new Map([["resource/a", dataFragment("a", "x")]]),
          providerSet: "builtin",
          region: "ap-south-1",
          backend: { kind: "http", address: c.value },
          tags: {},
        })
      );
      if (!code) expect(new URL(c.value).protocol, c.id).toBe("https:");
    }
  });
});

describe("assembleWorkspace: provisioners, connections, remote state and foreign providers are refused wherever they hide", () => {
  const evil: [string, TofuFragment][] = [
    ["provisioner (array form)", { resource: { terraform_data: { a: { provisioner: [{ "local-exec": { command: "echo x" } }] } } }, addresses: ["terraform_data.a"] }],
    ["provisioner (object form)", { resource: { terraform_data: { a: { provisioner: { "local-exec": { command: "echo x" } } } } }, addresses: ["terraform_data.a"] }],
    ["connection block", { resource: { terraform_data: { a: { connection: { type: "ssh", host: "x" } } } }, addresses: ["terraform_data.a"] }],
    ["remote state", { data: { terraform_remote_state: { s: { backend: "s3" } } }, addresses: ["data.terraform_remote_state.s"] }],
    ["external data source", { data: { external: { x: { program: ["echo"] } } }, addresses: ["data.external.x"] }],
    ["null_resource (provider not in set)", { resource: { null_resource: { a: {} } }, addresses: ["null_resource.a"] }],
    ["local_file (provider not in set)", { resource: { local_file: { a: { filename: "/tmp/x", content: "x" } } }, addresses: ["local_file.a"] }],
    ["http data source (provider not in set)", { data: { http: { a: { url: "https://exfil.invalid" } } }, addresses: ["data.http.a"] }],
  ];
  for (const [name, fragment] of evil) {
    it(name, () => {
      expect(refusedBy(() => builtinWorkspace(STATE, { "resource/a": fragment }))).toBeDefined();
    });
  }

  it("a fragment may not bring its own terraform/provider/module/variable blocks", () => {
    for (const key of ["terraform", "provider", "module", "variable", "import", "moved", "removed", "check"]) {
      expect(refusedBy(() => builtinWorkspace(STATE, { "resource/a": { ...dataFragment("a", "x"), [key]: {} } as TofuFragment })), key).toBe("invalid_fragment");
    }
  });

  it("an ephemeral block (C5) gets the same guards: a pinned provider only, never the builtin terraform_data, well-formed types and bodies", () => {
    const withEphemeral = (ephemeral: unknown) => () => builtinWorkspace(STATE, { "resource/a": { ...dataFragment("a", "x"), ephemeral } as TofuFragment });
    expect(refusedBy(withEphemeral({ terraform_data: { e: {} } }))).toBe("invalid_fragment");
    expect(refusedBy(withEphemeral({ random_password: { e: { length: 16 } } }))).toBe("invalid_fragment"); // random is not in the builtin provider set
    expect(refusedBy(withEphemeral({ "../x": { e: {} } }))).toBe("invalid_fragment");
    expect(refusedBy(withEphemeral([]))).toBe("invalid_fragment");
  });
});

/* ---------------------------------- part 3 ---------------------------------- */

describe.skipIf(!hasTofu)("what the assembler ACCEPTS, real OpenTofu must not turn into a file read or a path leak (SEC-F5)", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const runner = new TofuRunner({ limits: { timeoutMs: 120_000 } });

  /** Plan a one-resource workspace and return the planned `input` attribute. */
  async function plannedInput(payload: string): Promise<{ refused: true } | { refused: false; input: unknown }> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zenith-sec-inj-"));
    dirs.push(dir);
    let ws: TofuWorkspace;
    try {
      ws = builtinWorkspace(path.join(dir, "terraform.tfstate"), { "resource/a": dataFragment("a", payload) });
    } catch (e) {
      if (e instanceof TofuWorkspaceError) return { refused: true };
      throw e;
    }
    let plan;
    try {
      ({ plan } = await planWorkspace(ws, undefined, { runner }));
    } catch (e) {
      // tofu itself rejected the expression (syntax error, unknown function): nothing was evaluated, nothing leaked
      if (e instanceof TofuCommandError) return { refused: true };
      throw e;
    }
    const change = plan.resourceChanges[0]?.changes.find((c) => c.path === "input");
    return { refused: false, input: change?.after };
  }

  // A file that is certain to exist in tofu's working directory, with a marker in it.
  const MARKER = "required_version";
  const FILE = "versions.tf.json";

  it("CONTROL: the harness works — a benign string plans and comes back unchanged", async () => {
    expect(await plannedInput("hello-world")).toEqual({ refused: false, input: "hello-world" });
    // …and tofu really does evaluate `${}` (so the later assertions can fail for the right reason)
    expect(await plannedInput('${upper("abc")}')).toEqual({ refused: false, input: "ABC" });
  }, 60_000);

  it("the plain, newline and space forms of file()/templatefile()/fileexists() are refused (existing regex works)", async () => {
    for (const payload of [`\${file("${FILE}")}`, `\${file\n("${FILE}")}`, `\${ file ("${FILE}") }`, `\${templatefile("${FILE}", {})}`, `\${fileexists("${FILE}")}`]) {
      expect(await plannedInput(payload), payload).toEqual({ refused: true });
    }
  }, 120_000);

  /** Comment styles HCL accepts between a function name and its argument list. */
  const STYLES: [string, (fn: string, args: string) => string][] = [
    ["block comment", (fn, a) => `\${${fn}/**/(${a})}`],
    ["spaced block comment", (fn, a) => `\${${fn} /* c */ (${a})}`],
    ["hash line comment", (fn, a) => `\${${fn} # c\n(${a})}`],
    ["slash line comment", (fn, a) => `\${${fn} // c\n(${a})}`],
    ["nested in try()", (fn, a) => `\${try(${fn}/**/(${a}), "x")}`],
    ["inside a directive", (fn, a) => `%{ if true }\${${fn}/**/(${a})}%{ endif }`],
  ];
  const READERS: [string, string, string][] = [
    ["file", `"${FILE}"`, MARKER],
    ["templatefile", `"${FILE}", {}`, MARKER],
    ["fileexists", `"${FILE}"`, "true"],
  ];

  /**
   * SEC-F5. For every (function, comment style): the assembler must refuse, or
   * tofu must not have read the file. Today the assembler accepts and tofu
   * reads it, so this fails — `it.fails` keeps it green until the regex scan is
   * replaced by something that cannot be argued out of a comment. When it
   * starts failing, the fix landed: change `it.fails` to `it`.
   */
  it("SEC-F5 (HIGH): a comment between a filesystem function and its parenthesis does not get past the assembler", async () => {
    const leaks: string[] = [];
    for (const [fn, args, marker] of READERS) {
      for (const [style, build] of STYLES) {
        const result = await plannedInput(build(fn, args));
        if (result.refused) continue;
        const text = JSON.stringify(result.input ?? "");
        // any successful evaluation of a filesystem function is a leak; the marker proves it read OUR file
        if (marker === "" ? text.length > 4 : text.includes(marker)) leaks.push(`${fn} via ${style} -> ${text.slice(0, 60)}`);
      }
    }
    expect(leaks, `tofu evaluated filesystem functions hidden from the assembler's regex:\n  ${leaks.join("\n  ")}`).toEqual([]);
  }, 600_000);

  it("SEC-F5 (LOW part): `path . cwd` and `path/**/.cwd` leak the runner's working directory", async () => {
    const leaked: string[] = [];
    for (const payload of ["${path . cwd}", "${path/**/.cwd}", "${path . module}", "${path\n.cwd}"]) {
      const result = await plannedInput(payload);
      if (!result.refused && typeof result.input === "string" && result.input.includes("zenith-tofu-run")) leaked.push(payload);
    }
    expect(leaked, "tofu evaluated a path reference the assembler's regex did not see").toEqual([]);
  }, 300_000);
});

/* ---------------------------------- part 4 ---------------------------------- */

describe("assembleWorkspace: known gaps (each test is it.fails until the assembler is fixed; flip it to `it` then)", () => {
  it("SEC-F4 (MEDIUM): nonsensitive() is refused, so a fragment cannot unmask a value tofu marked sensitive", () => {
    for (const expression of ['${nonsensitive(aws_secretsmanager_secret_version.s.secret_string)}', "${nonsensitive/**/(local.x)}", '${try(nonsensitive(local.x), "")}']) {
      const code = refusedBy(() => builtinWorkspace(STATE, { "resource/a": dataFragment("a", expression) }));
      expect(code, `${expression} must be refused`).toBe("forbidden_construct");
    }
  });

  it("SEC-F3 (MEDIUM, latent): providerConfig cannot redirect, proxy, weaken or re-identify the provider's API calls", () => {
    const dangerous: Record<string, unknown>[] = [
      { endpoints: [{ sts: "https://sts.exfil.invalid" }] },
      { http_proxy: "https://proxy.exfil.invalid" },
      { https_proxy: "https://proxy.exfil.invalid" },
      { custom_ca_bundle: "/tmp/attacker-ca.pem" },
      { ec2_metadata_service_endpoint: "http://exfil.invalid" },
      { insecure: true },
      { assume_role: [{ role_arn: "arn:aws:iam::123456789012:role/attacker" }] },
      { profile: "attacker" },
    ];
    const accepted = dangerous.filter((cfg) => {
      try {
        assembleWorkspace({
          graph: graphOf([node("resource/a")]),
          fragments: new Map([["resource/a", dataFragment("a", "x")]]),
          providerSet: "aws",
          region: "ap-south-1",
          backend: { kind: "local" },
          tags: {},
          providerConfig: { aws: cfg },
        });
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted.map((c) => Object.keys(c)[0]), "providerConfig keys that would redirect or weaken the credentialed API traffic were accepted").toEqual([]);
  });

  it("SEC-F2 (LOW): a resource, output or local named __proto__ is refused or kept — never silently dropped", () => {
    const dropped: string[] = [];
    for (const build of [
      (): TofuFragment => ({ resource: { terraform_data: JSON.parse('{"__proto__": {"input": "x"}}') as never }, addresses: ["terraform_data.__proto__"] }),
      (): TofuFragment => ({ ...dataFragment("a", "x"), output: JSON.parse('{"__proto__": {"value": "x"}}') as never }),
      (): TofuFragment => ({ ...dataFragment("a", "x"), locals: JSON.parse('{"__proto__": "x"}') as never }),
    ]) {
      let ws: TofuWorkspace | undefined;
      if (refusedBy(() => (ws = builtinWorkspace(STATE, { "resource/a": build() })))) continue;
      const main = JSON.parse(ws!.files.find((f) => f.path === "main.tf.json")!.content) as Record<string, Record<string, unknown>>;
      const present = JSON.stringify(main).includes("__proto__");
      if (!present) dropped.push(JSON.stringify(ws!.addressMap));
    }
    expect(dropped, "the label was accepted and then vanished from main.tf.json").toEqual([]);
  });
});
