/** Genuine OPA1.10 evaluator with the licensed formatter precision repair. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicy } from "@/lib/policy/vendor/opa-wasm/index.mjs";
import { createPolicyEngine } from "@/lib/policy";
import { policyInput } from "./support";

const vendor = path.join(process.cwd(), "src/lib/policy/vendor/opa-wasm");
const formatterPath = path.join(vendor, "builtins/sprintf.js");
const formatter = createRequire(import.meta.url)(formatterPath) as {
  sprintf: (format: string, ...values: unknown[]) => string;
  vsprintf: (format: string, values: unknown[]) => string;
};
const fixture = path.join(process.cwd(), "tests/policy/fixtures/sprintf-precision.wasm");
// Genuine pinned OPA1.19.1 compilation from the adjacent Rego; no mocked module.
const FIXTURE_SHA256 = "28af6ab32948c2900d2966eb31fa44c933354c6c5635dbd55f5e3784d0a60007";
const refusal = "[sprintf] numeric precision outside supported range";
const input = (format: string, value: unknown, variant = "else") => ({ request: { constraints: { format, value, variant } } });
const fixtureBytes = () => {
  const bytes = readFileSync(fixture);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(FIXTURE_SHA256);
  return bytes;
};

describe("vendored OPA numeric precision security", () => {
  it("preserves valid floating boundaries, positional, named and non-floating formats", () => {
    expect(formatter.vsprintf("%.0f/%.0e/%.1g", [1.25, 1.25, 1.25])).toBe("1/1e+0/1");
    expect(formatter.vsprintf("%2$.2f/%1$.1e", [1.25, 2.5])).toBe("2.50/1.3e+0");
    expect(formatter.vsprintf("%(number).2f/%(label)s", [{ number: 1.25, label: "safe" }])).toBe("1.25/safe");
    expect(formatter.vsprintf("%t/%T/%v/%j/%b/%x/%%", [true, [], "text", { n: 1 }, 5, 15])).toBe('true/array/text/{"n":1}/101/f/%');
    for (const specifier of ["e", "f", "g"]) {
      const precision = 100;
      const expected = specifier === "e" ? (1).toExponential(precision) : specifier === "f" ? (1).toFixed(precision) : String(Number((1).toPrecision(precision)));
      expect(formatter.sprintf(`%.${precision}${specifier}`, 1)).toBe(expected);
    }
    // String precision is not a numeric conversion and retains its old behavior.
    expect(formatter.sprintf("%.101s", "ordinary")).toBe("ordinary");
  });

  it("rejects adversarial precision before native methods in a bounded real subprocess", () => {
    const script = `
      const assert = require("node:assert/strict");
      const f = require(process.argv[1]);
      const old = {}; let nativeCalls = 0;
      for (const name of ["toFixed", "toExponential", "toPrecision"]) {
        old[name] = Number.prototype[name];
        Number.prototype[name] = function (...args) { nativeCalls++; return old[name].apply(this, args); };
      }
      const invalid = [["%.101e", [1]], ["%.101f", [1]], ["%.101g", [1]], ["%.0g", [1]], ["%2$.999f", [0, 1]], ["%(number).999e", [{number:1}]], ["%." + "9".repeat(20000) + "f", [1]]];
      let refused = 0;
      for (const [format, values] of invalid) {
        let error; try { f.vsprintf(format, values); } catch (caught) { error = caught; }
        assert.equal(error instanceof RangeError, true);
        assert.equal(error.message, "[sprintf] numeric precision outside supported range");
        refused++;
      }
      assert.equal(nativeCalls, 0);
      for (let i=0; i<1000; i++) assert.equal(f.vsprintf("%.2f", [1.25]), "1.25");
      assert.equal(nativeCalls, 1000);
      process.stdout.write(JSON.stringify({refused, nativeCalls, recovered:true}));
    `;
    const result = spawnSync(process.execPath, ["-e", script, formatterPath], {
      encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 16 * 1024,
      env: { NODE_ENV: "test" },
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout) as unknown).toEqual({ refused: 7, nativeCalls: 1000, recovered: true });
  });

  it("executes the genuine Wasm host sprintf join and preserves valid named and positional output", async () => {
    const loaded = await loadPolicy(fixtureBytes());
    expect(loaded.entrypoints).toMatchObject({ "vendor_precision/decision": 0 });
    const exports = (loaded.wasmInstance as WebAssembly.Instance).exports as Record<string, (...args: number[]) => number>;
    const start = exports.opa_json_dump(exports.builtins());
    const heap = new Uint8Array(loaded.mem.buffer); let end = start;
    while (heap[end] !== 0) end++;
    expect(Object.keys(JSON.parse(new TextDecoder().decode(heap.subarray(start, end))) as Record<string, number>)).toEqual(["sprintf"]);
    expect(loaded.evaluate(input("%.2f", 1.25), "vendor_precision/probe")).toEqual([{ result: "1.25" }]);
    expect(loaded.evaluate(input("%1$.2f", 1.25), "vendor_precision/probe")).toEqual([{ result: "1.25" }]);
    expect(loaded.evaluate(input("%(number).2f", { number: 1.25 }), "vendor_precision/probe")).toEqual([{ result: "1.25" }]);
    expect(() => loaded.evaluate(input("%.101f", 1), "vendor_precision/probe")).toThrow(new RangeError(refusal));
    expect(loaded.evaluate(input("%.2f", 1.25), "vendor_precision/probe")).toEqual([{ result: "1.25" }]);
  });

  it("fails closed through the production engine for invalid precision in default, negation and else rules", async () => {
    const loaded = await loadPolicy(fixtureBytes());
    const engine = createPolicyEngine(loaded, FIXTURE_SHA256);
    for (const variant of ["default", "negation", "else"]) {
      for (const format of ["%.101e", "%.101f", "%.101g", "%.0g"]) {
        const actual = await engine.evaluate(policyInput("infrastructure.plan", { request: { constraints: { variant, format, value: 1 } } }));
        expect(actual.decision).toMatchObject({ outcome: "deny", reasons: [{ code: "policy_error", rule: "zenith.engine.evaluation", message: "Policy evaluation failed; the request is denied." }] });
        expect(JSON.stringify(actual)).not.toContain(format);
        // The same genuine Wasm instance and public engine remain usable.
        const next = await engine.evaluate(policyInput("infrastructure.plan", { request: { constraints: { variant: "else", format: "%.2f", value: 1.25 } } }));
        expect(next.decision.outcome).toBe("allow");
      }
    }
  });
});
