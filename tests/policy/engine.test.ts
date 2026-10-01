/**
 * The engine: loading, determinism, input/output validation, fail-closed
 * behaviour, and the guarantees about what the wasm may touch.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPolicy } from "@open-policy-agent/opa-wasm";
import { digest, sha256Hex } from "@/lib/controlplane/digest";
import {
  createPolicyEngine,
  loadPolicyEngine,
  PolicyLoadError,
  policyWasmPath,
  resetPolicyEngineCache,
  type PolicyEngine,
  type PolicyInput,
} from "@/lib/policy";
import { NOW, planFacts, policyInput, production } from "./support";

const REPO_WASM = path.join(process.cwd(), "policy", "dist", "policy.wasm");
const REPO_MANIFEST = path.join(process.cwd(), "policy", "dist", "manifest.json");
const manifest = JSON.parse(readFileSync(REPO_MANIFEST, "utf8")) as { wasmSha256: string; entrypoint: string };

let engine: PolicyEngine;
beforeAll(async () => {
  engine = await loadPolicyEngine();
});

/** Evaluate a document the type system would refuse: the engine must cope with anything. */
const evaluateRaw = (input: unknown) => engine.evaluate(input as PolicyInput);

const policyError = (decision: { outcome: string; reasons: { code: string; rule?: string }[] }, stage: string) => {
  expect(decision.outcome).toBe("deny");
  expect(decision.reasons).toHaveLength(1);
  expect(decision.reasons[0].code).toBe("policy_error");
  expect(decision.reasons[0].rule).toBe(`zenith.engine.${stage}`);
};

describe("loading", () => {
  it("loads the committed bundle and reports the manifest's sha256 as the policy version", () => {
    expect(engine.version).toBe(manifest.wasmSha256);
    expect(engine.version).toBe(sha256Hex(readFileSync(REPO_WASM)));
  });

  it("caches the loaded engine per wasm path", async () => {
    expect(await loadPolicyEngine()).toBe(engine);
    expect(loadPolicyEngine()).toBe(loadPolicyEngine());
  });

  it("resolves the default path from the working directory and honours ZENITH_POLICY_WASM", () => {
    expect(policyWasmPath()).toBe(REPO_WASM);
    vi.stubEnv("ZENITH_POLICY_WASM", path.join(tmpdir(), "elsewhere", "p.wasm"));
    expect(policyWasmPath()).toBe(path.join(tmpdir(), "elsewhere", "p.wasm"));
    vi.stubEnv("ZENITH_POLICY_WASM", "   ");
    expect(policyWasmPath()).toBe(REPO_WASM);
    vi.unstubAllEnvs();
  });

  it("the bundle imports nothing but the OPA ABI and needs no host builtin that could read a clock, the network or randomness", async () => {
    const bytes = readFileSync(REPO_WASM);
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
    expect(new Set(imports.map((i) => i.module))).toEqual(new Set(["env"]));
    expect(imports.map((i) => i.name).sort()).toEqual(["memory", "opa_abort", "opa_builtin0", "opa_builtin1", "opa_builtin2", "opa_builtin3", "opa_builtin4"]);

    // Builtins the module asks the host to implement (everything else is native to the wasm).
    const loaded = await loadPolicy(bytes);
    const exports = (loaded as unknown as { wasmInstance: { exports: Record<string, (...args: number[]) => number> } }).wasmInstance.exports;
    const memory = (loaded as unknown as { mem: WebAssembly.Memory }).mem;
    const addr = exports.opa_json_dump(exports.builtins());
    const heap = new Uint8Array(memory.buffer);
    let end = addr;
    while (heap[end] !== 0) end += 1;
    const hostBuiltins = Object.keys(JSON.parse(new TextDecoder().decode(heap.subarray(addr, end))) as Record<string, number>);
    expect(hostBuiltins.length).toBeGreaterThan(0);
    for (const name of hostBuiltins) expect(name).not.toMatch(/^(http\.|time\.|rand\.|uuid\.|net\.|opa\.|trace$|print$|crypto\.|io\.|env)/);
    expect(hostBuiltins).toEqual(["sprintf"]);
  });
});

describe("determinism", () => {
  it("gives identical results, digests and versions for identical input", async () => {
    const input = policyInput("infrastructure.apply", { ...production, plan: planFacts({ costDeltaUsdMonthly: 60, openIngress: [{ address: "a", port: "22", cidr: "0.0.0.0/0" }] }) });
    const first = await engine.evaluate(input);
    const second = await engine.evaluate(structuredClone(input));
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.inputDigest).toBe(digest(input));
    expect(first.policyVersion).toBe(engine.version);
  });

  it("does not depend on key order", async () => {
    const reverseKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)]))
          : value;
    const input = policyInput("infrastructure.apply", { plan: planFacts({ regions: ["eu-west-1"], costDeltaUsdMonthly: 3 }) });
    const reordered = reverseKeys(input) as PolicyInput;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(input));
    expect(await engine.evaluate(reordered)).toEqual(await engine.evaluate(input));
  });

  it("changes the digest when anything in the input changes", async () => {
    const a = await engine.evaluate(policyInput("service.restart"));
    const b = await engine.evaluate(policyInput("service.restart", { environment: { autonomyLevel: 3 } }));
    expect(a.inputDigest).not.toBe(b.inputDigest);
  });

  it("takes time only from the input: evaluatedAt is context.now whatever the wall clock says", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
      const early = await engine.evaluate(policyInput("service.restart"));
      vi.setSystemTime(new Date("2099-12-31T00:00:00Z"));
      const late = await engine.evaluate(policyInput("service.restart"));
      expect(early).toEqual(late);
      expect(early.evaluatedAt).toBe(NOW);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the same answers concurrently as sequentially", async () => {
    const inputs = Array.from({ length: 60 }, (_, i) => policyInput(i % 2 ? "service.restart" : "firewall.modify", { environment: { autonomyLevel: (i % 6) as 0 | 1 | 2 | 3 | 4 | 5, class: i % 3 ? "production" : "development" } }));
    const sequential: string[] = [];
    for (const input of inputs) sequential.push(JSON.stringify(await engine.evaluate(input)));
    const parallel = (await Promise.all(inputs.map((input) => engine.evaluate(input)))).map((r) => JSON.stringify(r));
    expect(parallel).toEqual(sequential);
  });

  it("handles a large plan without exhausting wasm memory", async () => {
    const addresses = Array.from({ length: 4000 }, (_, i) => `aws_db_instance.instance_${i}_${"x".repeat(150)}`);
    const result = await engine.evaluate(policyInput("infrastructure.apply", { environment: { autonomyLevel: 5 }, plan: planFacts({ delete: 4000, destroysData: true, destroyedStatefulAddresses: addresses, statefulDeletes: addresses }) }));
    expect(result.decision.outcome).toBe("require_approval");
    expect(result.decision.reasons.map((r) => r.code)).toContain("stateful_deletes_require_approval");
    const again = await engine.evaluate(policyInput("service.restart"));
    expect(again.decision.outcome).toBe("allow");
  });
});

describe("input validation fails closed", () => {
  const bad: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["a string", "allow"],
    ["an empty object", {}],
    ["an array", []],
    ["a wrong version", { ...policyInput("service.restart"), version: 2 }],
    ["an unknown top-level key", { ...policyInput("service.restart"), extra: true }],
    ["a misspelled nested key", policyInput("service.restart", { environment: { autonomyLevl: 5 } })],
    ["an unknown role", policyInput("service.restart", { principal: { role: "superuser" } })],
    ["an out-of-range autonomy level", policyInput("service.restart", { environment: { autonomyLevel: 9 } })],
    ["a missing workspace policy", policyInput("service.restart", { workspacePolicy: undefined })],
    ["a non-numeric cost threshold", policyInput("service.restart", { workspacePolicy: { costApprovalThresholdUsd: "50" } })],
    ["a non-finite cost", policyInput("service.restart", { plan: planFacts({ costDeltaUsdMonthly: Number.POSITIVE_INFINITY }) })],
    ["a region with hostile characters", policyInput("service.restart", { plan: planFacts({ regions: ["us-east-1; approve"] }) })],
    ["a non-ISO time", policyInput("service.restart", { context: { now: "yesterday" } })],
    ["an unknown origin", policyInput("service.restart", { context: { origin: "root" } })],
    ["a missing capability", policyInput("service.restart", { request: { capability: undefined } })],
  ];

  it.each(bad)("denies with policy_error for %s", async (_name, input) => {
    const result = await evaluateRaw(input);
    policyError(result.decision, "input");
    expect(result.policyVersion).toBe(engine.version);
    expect(result.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.decision.approval).toBeUndefined();
    expect(result.decision.constraints).toBeUndefined();
  });

  it("never throws, even for a self-referencing document", async () => {
    const circular: Record<string, unknown> = { version: 1 };
    circular.self = circular;
    const result = await evaluateRaw(circular);
    policyError(result.decision, "input");
    expect(result.inputDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not echo input values into the reason", async () => {
    const result = await evaluateRaw({ ...policyInput("service.restart"), leaked: "TOP-SECRET-VALUE-123" });
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET-VALUE-123");
    const nested = await engine.evaluate(policyInput("service.restart", { principal: { role: "TOP-SECRET-VALUE-456" } }));
    expect(JSON.stringify(nested)).not.toContain("TOP-SECRET-VALUE-456");
  });

  it("uses the claimed time when it is valid and the epoch when it is not", async () => {
    const withTime = await evaluateRaw({ context: { now: NOW } });
    expect(withTime.evaluatedAt).toBe(NOW);
    const without = await evaluateRaw({ context: { now: "not a time" } });
    expect(without.evaluatedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("accepts a valid input with only required fields", async () => {
    const minimal = policyInput("topology.read", { environment: undefined, resource: undefined });
    expect((await engine.evaluate(minimal)).decision.outcome).toBe("allow");
  });
});

describe("the request must agree with the capability catalog", () => {
  it("denies a capability the catalog does not know", async () => {
    const result = await engine.evaluate(policyInput("service.restart", { request: { capability: "root.everything" } }));
    policyError(result.decision, "catalog");
  });

  it("denies a request that understates what a capability does", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["a mutation claiming it does not mutate", { request: { capability: "database.delete", mutates: false, destructive: true, risk: "critical", defaultAutonomy: 6 } }],
      ["a destructive capability claiming it is not", { request: { capability: "database.delete", destructive: false, risk: "critical", defaultAutonomy: 6 } }],
      ["an escape hatch claiming it is not", { request: { capability: "machine.exec", escapeHatch: false, risk: "critical", defaultAutonomy: 6 } }],
      ["a capability claiming a lower autonomy requirement", { request: { capability: "infrastructure.apply", risk: "high", defaultAutonomy: 0 } }],
      ["a critical capability claiming low risk", { request: { capability: "identity.modify", risk: "low", defaultAutonomy: 6 } }],
      ["a capability naming the wrong integration scope", { request: { capability: "logs.read", mutates: false, risk: "low", defaultAutonomy: 0, integrationScope: "read" } }],
    ];
    for (const [label, patch] of cases) {
      const base = policyInput("service.restart", { principal: { role: "admin" } });
      const result = await engine.evaluate({ ...base, request: { ...base.request, ...(patch.request as object) } });
      expect(result.decision.outcome, label).toBe("deny");
      policyError(result.decision, "catalog");
    }
  });

  it("allows a request whose risk is higher than the catalog floor (policy may raise risk)", async () => {
    const result = await engine.evaluate(policyInput("service.restart", { request: { risk: "critical" } }));
    expect(result.decision.outcome).toBe("allow");
  });

  it("fills the integration scope from the catalog when the request omits it", async () => {
    const omitted = policyInput("service.restart", { principal: { kind: "integration", integrationScopes: ["read"] }, request: { integrationScope: undefined } });
    const denied = await engine.evaluate(omitted);
    expect(denied.decision.reasons.map((r) => r.code)).toEqual(["integration_scope_missing"]);

    const granted = policyInput("service.restart", { principal: { kind: "integration", integrationScopes: ["write"] }, request: { integrationScope: undefined } });
    expect((await engine.evaluate(granted)).decision.outcome).toBe("allow");
  });

  it("does not change the input digest when the engine fills the scope", async () => {
    const omitted = policyInput("service.restart", { request: { integrationScope: undefined } });
    expect((await engine.evaluate(omitted)).inputDigest).toBe(digest(omitted));
  });
});

describe("evaluation and output failures fail closed", () => {
  const input = policyInput("service.restart");
  const good = { outcome: "allow", reasons: [{ code: "allowed_within_policy", message: "ok", rule: "zenith.decision.allow" }] };

  const engineReturning = (value: unknown) => createPolicyEngine({ evaluate: () => value }, "v-test");

  it("passes a well-formed decision through", async () => {
    const result = await engineReturning([{ result: good }]).evaluate(input);
    expect(result.decision).toEqual(good);
    expect(result.policyVersion).toBe("v-test");
  });

  it("denies when the wasm throws, without leaking the error", async () => {
    const throwing = createPolicyEngine(
      {
        evaluate: () => {
          throw new Error("internal trap 0xdeadbeef");
        },
      },
      "v-test"
    );
    const result = await throwing.evaluate(input);
    policyError(result.decision, "evaluation");
    expect(JSON.stringify(result)).not.toContain("deadbeef");
  });

  const unusable: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["an empty result set (undefined entrypoint)", []],
    ["a result set without a result", [{}]],
    ["two results", [{ result: good }, { result: good }]],
    ["a bare object", good],
    ["a string outcome", [{ result: "allow" }]],
    ["an unknown outcome", [{ result: { ...good, outcome: "maybe" } }]],
    ["an allow with an empty reason list", [{ result: { outcome: "allow", reasons: [] } }]],
    ["an allow without reasons", [{ result: { outcome: "allow" } }]],
    ["a reason without a code", [{ result: { outcome: "allow", reasons: [{ message: "x" }] } }]],
    ["an extra key", [{ result: { ...good, debug: true } }]],
    ["require_approval without an approval requirement", [{ result: { outcome: "require_approval", reasons: good.reasons } }]],
    ["an approval requirement on an allow", [{ result: { ...good, approval: { count: 1, minRole: "editor", separationOfDuties: false } } }]],
    ["an approval with a viewer role", [{ result: { outcome: "require_approval", reasons: good.reasons, approval: { count: 1, minRole: "viewer", separationOfDuties: false } } }]],
    ["an approval count of zero", [{ result: { outcome: "require_approval", reasons: good.reasons, approval: { count: 0, minRole: "admin", separationOfDuties: false } } }]],
    ["constraints on a denial", [{ result: { outcome: "deny", reasons: good.reasons, constraints: { maxLines: 1 } } }]],
    ["nested constraint objects", [{ result: { ...good, constraints: { maxLines: { deep: 1 } } } }]],
  ];

  it.each(unusable)("denies when the wasm returns %s", async (_name, value) => {
    const result = await engineReturning(value).evaluate(input);
    policyError(result.decision, "output");
  });

  it("accepts a well-formed approval and constraints", async () => {
    const decision = {
      outcome: "require_approval",
      reasons: good.reasons,
      approval: { count: 1, minRole: "admin", separationOfDuties: true },
      constraints: { timeoutSec: 300 },
    };
    expect((await engineReturning([{ result: decision }]).evaluate(input)).decision).toEqual(decision);
  });

  it("hands the wasm the validated input plus the catalog scope, and nothing else", async () => {
    const seen: unknown[] = [];
    const spy = createPolicyEngine({ evaluate: (i) => (seen.push(i), [{ result: good }]) }, "v-test");
    await spy.evaluate(policyInput("logs.read", { request: { integrationScope: undefined } }));
    expect(seen).toHaveLength(1);
    expect((seen[0] as PolicyInput).request.integrationScope).toBe("logs");
  });

  it("does not evaluate at all when validation fails", async () => {
    const evaluate = vi.fn(() => [{ result: good }]);
    const guarded = createPolicyEngine({ evaluate }, "v-test");
    await guarded.evaluate({ nope: true } as unknown as PolicyInput);
    await guarded.evaluate(policyInput("database.delete", { request: { mutates: false } }));
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe("a bad bundle is a load failure, not a silent allow", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "zenith-policy-test-"));
    resetPolicyEngineCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
    resetPolicyEngineCache();
  });

  const install = (wasmBytes?: Buffer, manifestText?: string) => {
    const wasmPath = path.join(dir, "policy.wasm");
    writeFileSync(wasmPath, wasmBytes ?? readFileSync(REPO_WASM));
    if (manifestText !== undefined) writeFileSync(path.join(dir, "manifest.json"), manifestText);
    return wasmPath;
  };

  it("rejects a file that is not wasm", async () => {
    const wasmPath = install(Buffer.from("this is not a wasm module"));
    await expect(loadPolicyEngine({ wasmPath })).rejects.toBeInstanceOf(PolicyLoadError);
  });

  it("rejects a truncated wasm", async () => {
    const wasmPath = install(readFileSync(REPO_WASM).subarray(0, 4000));
    await expect(loadPolicyEngine({ wasmPath })).rejects.toBeInstanceOf(PolicyLoadError);
  });

  it("rejects a missing file", async () => {
    await expect(loadPolicyEngine({ wasmPath: path.join(dir, "absent.wasm") })).rejects.toBeInstanceOf(PolicyLoadError);
  });

  it("honours ZENITH_POLICY_WASM, and a corrupt file there fails the load", async () => {
    const wasmPath = install(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 255, 255]));
    vi.stubEnv("ZENITH_POLICY_WASM", wasmPath);
    await expect(loadPolicyEngine()).rejects.toBeInstanceOf(PolicyLoadError);
  });

  it("rejects a wasm that does not match its manifest (tampering)", async () => {
    const tampered = Buffer.concat([readFileSync(REPO_WASM), Buffer.from([0])]);
    const wasmPath = install(tampered, readFileSync(REPO_MANIFEST, "utf8"));
    await expect(loadPolicyEngine({ wasmPath })).rejects.toThrow(/does not match its manifest/);
  });

  it("rejects a malformed manifest", async () => {
    const wasmPath = install(undefined, "{ not json");
    await expect(loadPolicyEngine({ wasmPath })).rejects.toThrow(/manifest is malformed/);
    const noHash = install(undefined, JSON.stringify({ entrypoint: manifest.entrypoint }));
    await expect(loadPolicyEngine({ wasmPath: noHash })).rejects.toThrow(/manifest is malformed/);
  });

  it("rejects a manifest for a different entrypoint", async () => {
    const wasmPath = install(undefined, JSON.stringify({ entrypoint: "other/entry", wasmSha256: manifest.wasmSha256 }));
    await expect(loadPolicyEngine({ wasmPath })).rejects.toThrow(/entrypoint/);
  });

  it("loads a good copy with a matching manifest and evaluates through it", async () => {
    const wasmPath = install(undefined, readFileSync(REPO_MANIFEST, "utf8"));
    const copy = await loadPolicyEngine({ wasmPath });
    expect(copy).not.toBe(engine);
    expect(copy.version).toBe(engine.version);
    expect(await copy.evaluate(policyInput("service.restart"))).toEqual(await engine.evaluate(policyInput("service.restart")));
  });

  it("falls back to the bytes' own sha256 when no manifest sits next to the wasm", async () => {
    const wasmPath = install();
    const copy = await loadPolicyEngine({ wasmPath });
    expect(copy.version).toBe(manifest.wasmSha256);
  });

  it("does not cache a failed load: repairing the file makes the next call succeed", async () => {
    const wasmPath = install(Buffer.from("garbage"));
    await expect(loadPolicyEngine({ wasmPath })).rejects.toBeInstanceOf(PolicyLoadError);
    copyFileSync(REPO_WASM, wasmPath);
    const repaired = await loadPolicyEngine({ wasmPath });
    expect((await repaired.evaluate(policyInput("service.restart"))).decision.outcome).toBe("allow");
  });

  it("reports the path but never file contents in a load error", async () => {
    const wasmPath = install(Buffer.from("SUPER-SECRET-CONTENT"));
    const error = (await loadPolicyEngine({ wasmPath }).catch((e: unknown) => e)) as Error;
    expect(String(error.message)).not.toContain("SUPER-SECRET-CONTENT");
  });
});
