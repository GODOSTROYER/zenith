/**
 * Policy engine security properties (WS-SEC).
 *
 * The policy workstream tests what the engine DOES (tests/policy/**). This file
 * states what it must NEVER do, as properties enumerated over the real
 * capability catalog and the real compiled wasm bundle — so a new capability, a
 * Rego edit or a wider principal set is held to the same invariants without
 * anyone remembering to add a case.
 *
 * Properties (each test name is the invariant):
 *   P1  an escape hatch is never `allow`ed, at any autonomy, role, origin or
 *       environment class; in production it is denied unless the workspace
 *       enables it, and then needs an admin plus a second person.
 *   P2  a capability whose catalog autonomy is "never" (6) is never `allow`ed.
 *   P3  a mutation below its catalog autonomy floor is never `allow`ed, whatever
 *       the workspace policy says.
 *   P4  viewers and non-members cannot mutate; system principals are the only
 *       ones exempt from needing a workspace role.
 *   P5  an integration's scopes are literal: `write` does not imply `read`.
 *   P6  deny excludes approval; every approval requirement is human-shaped
 *       (count >= 1, minRole editor/admin).
 *   P7  agent- and Navigator-origin high/critical work is never allowed
 *       unattended.
 *   P8  externally derived strings are data: planting hostile strings in
 *       addresses, ids and provider names never changes the decision and is
 *       never echoed into a reason.
 *   P9  a corrupt, truncated or mismatched bundle is a load failure.
 *
 * Findings:
 *   SEC-F8 (MEDIUM, defense in depth): P7 holds only for `context.origin` in
 *   {agent, navigator}. An `integration` or `navigator` PRINCIPAL whose input
 *   says `origin: "human"` is allowed to run high-risk work unattended
 *   (`infrastructure.apply` in production at autonomy 5 for a navigator). The
 *   broker must label origin from the authenticated principal, never from the
 *   request — that is untestable here and is listed as a pending hook for
 *   WS-CAP in tests/security/README.md — but the policy itself should not
 *   depend on the label alone. Two `it.fails` below state the invariant.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITIES } from "@/lib/capabilities/catalog";
import { loadPolicyEngine, PolicyLoadError, resetPolicyEngineCache, type PolicyEngine, type PolicyInput } from "@/lib/policy";
import { sha256Hex } from "@/lib/controlplane/digest";
import { assertNoCanaries, canarySecret, injectionsFor, SMALL_CATEGORIES } from "../_support/security";
import { allCapabilities, AUTONOMY_LEVELS, emptyPlanFacts, ENV_CLASSES, ORIGINS, patchOf, policyInputFor, PRINCIPAL_KINDS, ROLES } from "../_support/security/policy";

let engine: PolicyEngine;
beforeAll(async () => {
  engine = await loadPolicyEngine();
});

const evaluate = (input: PolicyInput) => engine.evaluate(input);
const caps = allCapabilities();
const mutating = caps.filter((c) => c.mutates);
const escapeHatches = caps.filter((c) => c.escapeHatch);

const describeInput = (i: PolicyInput) =>
  `${i.request.capability} principal=${i.principal.kind}/${i.principal.role} origin=${i.context.origin} env=${i.environment?.class}@${i.environment?.autonomyLevel}`;

describe("P1: escape hatches (machine.exec, container.exec, provider.native)", () => {
  it("has the escape hatches the catalog declares", () => {
    expect(escapeHatches.map((c) => c.name).sort()).toEqual(["container.exec", "machine.exec", "provider.native"]);
  });

  it("are never allowed, for any principal kind, role, origin, environment class or autonomy, with or without the workspace opt-in", async () => {
    let evaluated = 0;
    for (const cap of escapeHatches) {
      for (const kind of PRINCIPAL_KINDS)
        for (const role of ROLES)
          for (const origin of ORIGINS)
            for (const envClass of ENV_CLASSES)
              for (const autonomy of [0, 3, 5] as const)
                for (const optIn of [false, true]) {
                  const input = policyInputFor(cap.name, { principal: { kind, role, integrationScopes: ["read", "plan", "logs", "write", "publish"] }, environment: { class: envClass, autonomyLevel: autonomy }, context: { origin } }, { allowEscapeHatchInProduction: optIn });
                  const r = await evaluate(input);
                  evaluated++;
                  if (r.decision.outcome === "allow") throw new Error(`SECURITY INVARIANT VIOLATED (P1): an escape hatch was allowed: ${describeInput(input)} optIn=${optIn}`);
                }
    }
    expect(evaluated).toBeGreaterThan(5000);
  }, 120_000);

  it("in production are denied by default, and with the workspace opt-in need an admin AND a second person", async () => {
    for (const cap of escapeHatches) {
      const denied = await evaluate(policyInputFor(cap.name, { principal: { role: "admin" }, environment: { class: "production", autonomyLevel: 5 } }));
      expect(denied.decision.outcome, cap.name).toBe("deny");
      expect(denied.decision.reasons.map((r) => r.code)).toContain("escape_hatch_denied_in_production");
      const opted = await evaluate(policyInputFor(cap.name, { principal: { role: "admin" }, environment: { class: "production", autonomyLevel: 5 } }, { allowEscapeHatchInProduction: true }));
      expect(opted.decision.outcome, cap.name).toBe("require_approval");
      expect(opted.decision.approval, cap.name).toEqual({ count: 1, minRole: "admin", separationOfDuties: true });
    }
  });

  it("carry hard timeout and output ceilings the executor must enforce, and a requester can only lower them", async () => {
    const ceiling = await evaluate(policyInputFor("machine.exec", { principal: { role: "admin" } }));
    expect(ceiling.decision.constraints).toMatchObject({ timeoutSec: 300, maxOutputBytes: 1048576 });
    const lowered = await evaluate(policyInputFor("machine.exec", { principal: { role: "admin" }, request: { constraints: { timeoutSec: 30, maxOutputBytes: 1000 } } }));
    expect(lowered.decision.constraints).toMatchObject({ timeoutSec: 30, maxOutputBytes: 1000 });
    const raised = await evaluate(policyInputFor("machine.exec", { principal: { role: "admin" }, request: { constraints: { timeoutSec: 99999, maxOutputBytes: 1e12 } } }));
    expect(raised.decision.constraints, "a request can never raise a ceiling").toMatchObject({ timeoutSec: 300, maxOutputBytes: 1048576 });
    for (const hostile of [-1, 0, Number.NaN, "abc", null]) {
      const r = await evaluate(policyInputFor("machine.exec", { principal: { role: "admin" }, request: { constraints: { timeoutSec: hostile as never } } }));
      if (r.decision.outcome !== "deny") expect(r.decision.constraints, `timeoutSec=${String(hostile)}`).toMatchObject({ timeoutSec: 300 });
    }
  });
});

describe("P2/P3: autonomy is a floor nothing can lower", () => {
  it("a capability the catalog marks 'never unattended' (defaultAutonomy 6) is never allowed, at any autonomy", async () => {
    const never = mutating.filter((c) => c.defaultAutonomy === 6);
    expect(never.map((c) => c.name).sort()).toEqual(["container.exec", "database.delete", "database.restore", "identity.modify", "infrastructure.destroy", "machine.exec", "provider.native", "resource.adopt", "resource.release"]);
    for (const cap of never)
      for (const autonomy of AUTONOMY_LEVELS)
        for (const envClass of ENV_CLASSES) {
          const input = policyInputFor(cap.name, { principal: { role: "admin" }, environment: { class: envClass, autonomyLevel: autonomy } });
          expect((await evaluate(input)).decision.outcome, describeInput(input)).not.toBe("allow");
        }
  });

  it("a mutation below its catalog autonomy floor is never allowed, however the workspace tunes its policy", async () => {
    const tunings = [
      undefined,
      { costApprovalThresholdUsd: 1e12 },
      { allowEscapeHatchInProduction: true },
      { twoPersonProduction: false },
      { autoRemediation: { sandbox: "any", development: "any", staging: "any", production: "any" } },
      { approvedRegions: ["us-east-1", "eu-west-1"] },
    ] as const;
    for (const cap of mutating)
      for (const autonomy of AUTONOMY_LEVELS) {
        if (autonomy >= cap.defaultAutonomy) continue;
        for (const tuning of tunings)
          for (const origin of ORIGINS) {
            const input = policyInputFor(cap.name, { principal: { role: "admin" }, environment: { autonomyLevel: autonomy }, context: { origin } }, tuning as never);
            const r = await evaluate(input);
            if (r.decision.outcome === "allow") throw new Error(`SECURITY INVARIANT VIOLATED (P3): ${describeInput(input)} was allowed below autonomy ${cap.defaultAutonomy} with tuning ${JSON.stringify(tuning)}`);
          }
      }
  }, 120_000);

  it("the catalog's unattended set is what this suite assumes (a catalog edit that widens it must be reviewed here)", () => {
    const unattendedAtFive = mutating.filter((c) => c.defaultAutonomy <= 5).map((c) => c.name).sort();
    expect(unattendedAtFive.length).toBe(mutating.length - mutating.filter((c) => c.defaultAutonomy === 6).length);
    // the destructive and escape-hatch capabilities are never among them
    for (const c of mutating) if (c.destructive || c.escapeHatch) expect(c.defaultAutonomy, c.name).toBe(6);
  });
});

describe("P4: who may mutate", () => {
  it("a viewer can never run a mutating capability", async () => {
    for (const cap of mutating)
      for (const kind of ["user", "integration", "navigator", "runner", "machine"] as const) {
        const r = await evaluate(policyInputFor(cap.name, { principal: { kind, role: "viewer", integrationScopes: ["write", "read", "plan", "logs", "publish"] }, environment: { autonomyLevel: 5 } }));
        expect(r.decision.outcome, `${cap.name} as viewer ${kind}`).toBe("deny");
        expect(r.decision.reasons.map((x) => x.code)).toContain("viewer_cannot_mutate");
      }
  });

  it("a principal with no role is refused for every capability, read-only included — except `system`", async () => {
    for (const cap of caps)
      for (const kind of PRINCIPAL_KINDS) {
        const r = await evaluate(policyInputFor(cap.name, { principal: { kind, role: "none", integrationScopes: ["read", "plan", "logs", "write", "publish"] }, environment: { autonomyLevel: 5 } }));
        if (kind === "system") expect(r.decision.reasons.map((x) => x.code), `${cap.name} as system`).not.toContain("no_workspace_role");
        else expect(r.decision.outcome, `${cap.name} as ${kind}/none`).toBe("deny");
      }
  });

  it("a mutation that names no environment is denied (production and autonomy rules cannot run without one)", async () => {
    for (const cap of mutating) {
      const r = await evaluate(policyInputFor(cap.name, { principal: { role: "admin" }, environment: undefined, resource: undefined }));
      expect(r.decision.outcome, cap.name).toBe("deny");
      expect(r.decision.reasons.map((x) => x.code)).toContain("mutation_environment_unresolved");
    }
  });

  it("resources Zenith does not own (referenced, external) are never mutated", async () => {
    for (const cap of mutating)
      for (const ownership of ["referenced", "external"] as const) {
        const r = await evaluate(policyInputFor(cap.name, { principal: { role: "admin" }, environment: { autonomyLevel: 5 }, resource: { ownership } }));
        expect(r.decision.outcome, `${cap.name} on ${ownership}`).toBe("deny");
      }
  });
});

describe("P5: integration scopes are literal", () => {
  const SCOPES = ["read", "plan", "logs", "write", "publish"] as const;

  it("a credential lacking the capability's scope is refused, whatever else it holds (write does not imply read)", async () => {
    for (const cap of caps) {
      const others = SCOPES.filter((s) => s !== cap.integrationScope);
      const r = await evaluate(policyInputFor(cap.name, { principal: { kind: "integration", role: "admin", integrationScopes: [...others] }, environment: { autonomyLevel: 5 } }));
      expect(r.decision.outcome, `${cap.name} needs ${cap.integrationScope} but got ${others.join("+")}`).toBe("deny");
      expect(r.decision.reasons.map((x) => x.code)).toContain("integration_scope_missing");
    }
  });

  it("a credential with no scopes at all is refused", async () => {
    for (const cap of caps) {
      for (const scopes of [undefined, []]) {
        const r = await evaluate(policyInputFor(cap.name, { principal: { kind: "integration", role: "admin", integrationScopes: scopes } }));
        expect(r.decision.outcome, `${cap.name} with scopes ${JSON.stringify(scopes)}`).toBe("deny");
      }
    }
  });

  it("the scope a request claims cannot disagree with the catalog (a broker that understates what it asks for is refused)", async () => {
    for (const cap of caps) {
      const wrong = SCOPES.find((s) => s !== cap.integrationScope)!;
      const r = await evaluate(policyInputFor(cap.name, { principal: { kind: "integration", role: "admin", integrationScopes: [wrong] }, request: { integrationScope: wrong } }));
      expect(r.decision.outcome, cap.name).toBe("deny");
      expect(r.decision.reasons[0].code).toBe("policy_error");
    }
  });
});

describe("P6: the shape of every decision", () => {
  it("across a wide sample, deny carries no approval, require_approval carries a human-shaped one, allow carries reasons", async () => {
    const seen = { allow: 0, deny: 0, require_approval: 0 };
    for (const cap of caps)
      for (const role of ["viewer", "editor", "admin"] as const)
        for (const origin of ["human", "agent", "reconciler"] as const)
          for (const envClass of ENV_CLASSES)
            for (const autonomy of [0, 4, 5] as const)
              for (const plan of [undefined, emptyPlanFacts(), emptyPlanFacts({ destroysData: true, delete: 1, costDeltaUsdMonthly: 500 })]) {
                const input = policyInputFor(cap.name, { principal: { role }, environment: { class: envClass, autonomyLevel: autonomy }, context: { origin }, plan });
                const { decision } = await evaluate(input);
                seen[decision.outcome]++;
                expect(decision.reasons.length, describeInput(input)).toBeGreaterThan(0);
                if (decision.outcome === "deny") {
                  expect(decision.approval, describeInput(input)).toBeUndefined();
                  expect(decision.constraints, describeInput(input)).toBeUndefined();
                }
                if (decision.outcome === "require_approval") {
                  expect(decision.approval!.count, describeInput(input)).toBeGreaterThanOrEqual(1);
                  expect(["editor", "admin"], describeInput(input)).toContain(decision.approval!.minRole);
                }
                if (decision.outcome === "allow") expect(decision.approval, describeInput(input)).toBeUndefined();
              }
    // the sample exercised every branch
    expect(seen.allow).toBeGreaterThan(50);
    expect(seen.deny).toBeGreaterThan(50);
    expect(seen.require_approval).toBeGreaterThan(50);
  }, 240_000);

  it("a production plan that destroys data is denied unless it is the explicit destroy capability, which needs an admin and a second person", async () => {
    for (const cap of mutating) {
      const r = await evaluate(policyInputFor(cap.name, { principal: { role: "admin" }, environment: { class: "production", autonomyLevel: 5 }, plan: emptyPlanFacts({ destroysData: true, delete: 1, destroyedStatefulAddresses: ["aws_db_instance.main"] }) }));
      if (cap.name === "infrastructure.destroy") {
        expect(r.decision.outcome).toBe("require_approval");
        expect(r.decision.approval).toEqual({ count: 1, minRole: "admin", separationOfDuties: true });
      } else {
        expect(r.decision.outcome, cap.name).toBe("deny");
      }
    }
  });

  it("deleting a database in production is denied outright (database.delete), and restores need an admin plus a second person", async () => {
    const del = await evaluate(policyInputFor("database.delete", { principal: { role: "admin" }, environment: { class: "production", autonomyLevel: 5 } }));
    expect(del.decision.outcome).toBe("deny");
    const restore = await evaluate(policyInputFor("database.restore", { principal: { role: "admin" }, environment: { class: "production", autonomyLevel: 5 } }));
    expect(restore.decision.outcome).toBe("require_approval");
    expect(restore.decision.approval).toMatchObject({ minRole: "admin", separationOfDuties: true });
  });
});

describe("P7: agents do not run high-risk work on their own authority", () => {
  const highRisk = caps.filter((c) => c.mutates && (c.risk === "high" || c.risk === "critical"));

  it("agent- and Navigator-origin high/critical mutations are never allowed", async () => {
    expect(highRisk.length).toBeGreaterThan(10);
    for (const cap of highRisk)
      for (const origin of ["agent", "navigator"] as const)
        for (const envClass of ENV_CLASSES)
          for (const kind of ["integration", "navigator", "user"] as const) {
            const input = policyInputFor(cap.name, { principal: { kind, role: "admin", integrationScopes: ["write", "read", "plan", "logs", "publish"] }, environment: { class: envClass, autonomyLevel: 5 }, context: { origin } });
            const r = await evaluate(input);
            if (r.decision.outcome === "allow") throw new Error(`SECURITY INVARIANT VIOLATED (P7): ${describeInput(input)} was allowed unattended`);
          }
  });

  it("the approval such work needs is a person's: editor or admin, never the integration itself", async () => {
    const r = await evaluate(policyInputFor("infrastructure.apply", { principal: { kind: "integration", role: "editor", integrationScopes: ["write"] }, context: { origin: "agent" }, environment: { autonomyLevel: 5 } }));
    expect(r.decision.outcome).toBe("require_approval");
    expect(r.decision.approval).toMatchObject({ count: 1 });
    expect(["editor", "admin"]).toContain(r.decision.approval!.minRole);
  });

  /**
   * SEC-F8. `agent_high_risk_requires_approval` keys on `context.origin` alone.
   * An integration or navigator principal whose input says `origin: "human"` is
   * allowed. The broker is meant to set origin from the authenticated
   * principal (pending hook, see README), but a policy that can be defeated by
   * one mislabelled field is one broker bug from an unattended production
   * apply by a model. When the rule also keys on `principal.kind`, flip these.
   */
  it("SEC-F8 (MEDIUM): an integration principal's high-risk mutation needs approval even if the input claims a human origin", async () => {
    const offenders: string[] = [];
    for (const cap of highRisk) {
      const input = policyInputFor(cap.name, { principal: { kind: "integration", role: "admin", integrationScopes: ["write", "read", "plan", "logs", "publish"] }, environment: { class: "development", autonomyLevel: 5 }, context: { origin: "human" } });
      if ((await evaluate(input)).decision.outcome === "allow") offenders.push(cap.name);
    }
    expect(offenders, "an integration principal with a human-labelled origin ran these unattended").toEqual([]);
  });

  it("SEC-F8 (MEDIUM): a navigator principal's high-risk mutation needs approval in PRODUCTION even if the input claims a human origin", async () => {
    const offenders: string[] = [];
    for (const cap of highRisk) {
      const input = policyInputFor(cap.name, { principal: { kind: "navigator", role: "admin" }, environment: { class: "production", autonomyLevel: 5 }, context: { origin: "human" } });
      if ((await evaluate(input)).decision.outcome === "allow") offenders.push(cap.name);
    }
    expect(offenders).toEqual([]);
  });
});

describe("P8: externally derived strings are data, never instructions", () => {
  /** the decision for a production apply by an admin at autonomy 5, with `over` merged on top (deeply) */
  const PROD_APPLY = { principal: { role: "admin" }, environment: { class: "production", autonomyLevel: 5 }, plan: emptyPlanFacts({ create: 1, regions: ["us-east-1"] }) } as const;
  const decide = async (over: Record<string, unknown> = {}) => {
    const r = await evaluate(policyInputFor("infrastructure.apply", patchOf(PROD_APPLY as never, over)));
    return { r, summary: { outcome: r.decision.outcome, codes: r.decision.reasons.map((x) => x.code), approval: r.decision.approval } };
  };
  const baseline = async () => (await decide()).summary;

  it("a hostile string in an address, id, kind, provider or plan list does not change the decision or appear in a reason", async () => {
    const expected = await baseline();
    const fields: [string, (s: string) => Record<string, unknown>][] = [
      ["resource.address", (s) => ({ resource: { address: s } })],
      ["resource.kind", (s) => ({ resource: { kind: s } })],
      ["environment.id", (s) => ({ environment: { id: s } })],
      ["environment.provider", (s) => ({ environment: { provider: s } })],
      ["principal.id", (s) => ({ principal: { id: s } })],
      ["scope.resourceId", (s) => ({ request: { scope: { workspaceId: "ws_1", resourceId: s } } })],
      ["plan.firewallChanges", (s) => ({ plan: emptyPlanFacts({ create: 1, regions: ["us-east-1"], firewallChanges: [s] }) })],
      ["plan.identityChanges", (s) => ({ plan: emptyPlanFacts({ create: 1, regions: ["us-east-1"], identityChanges: [s] }) })],
      ["plan.unresolved", (s) => ({ plan: emptyPlanFacts({ create: 1, regions: ["us-east-1"], unresolved: [s] }) })],
    ];
    for (const c of injectionsFor(...SMALL_CATEGORIES)) {
      for (const [name, build] of fields) {
        const { r, summary } = await decide(build(c.value));
        // strings the schema bounds (1..1024 chars) are evaluated; anything else must fail closed
        if (r.decision.reasons[0].code === "policy_error") {
          expect(r.decision.outcome, `${name} <- ${c.id}`).toBe("deny");
          continue;
        }
        if (name.startsWith("plan.")) {
          // a non-empty firewall/identity/unresolved list legitimately adds approval rules; the STRING itself must not matter
          const field = name.slice(5);
          const benign = await decide({ plan: emptyPlanFacts({ create: 1, regions: ["us-east-1"], [field]: ["aws_x.benign"] }) });
          expect(summary, `${name} <- ${c.id}`).toEqual(benign.summary);
        } else {
          expect(summary, `${name} <- ${c.id}`).toEqual(expected);
        }
        expect(JSON.stringify(r.decision.reasons), `${name} <- ${c.id}: a reason must not echo external text`).not.toContain(c.value.slice(0, 12));
      }
    }
  }, 120_000);

  it("a canary in any free-text field never reaches a decision reason, in any encoding", async () => {
    const secret = canarySecret("policy-echo", "password");
    const input = policyInputFor("infrastructure.apply", {
      principal: { role: "admin", id: `user-${secret}` },
      environment: { class: "production", autonomyLevel: 5, id: `env-${secret}` },
      resource: { address: `aws_db_instance.${secret}`, kind: secret },
      plan: emptyPlanFacts({ create: 1, regions: ["us-east-1"], openIngress: [{ address: `aws_security_group.${secret}`, port: "22", cidr: "0.0.0.0/0" }], wildcardIam: [`aws_iam_policy.${secret}`], destroyedStatefulAddresses: [`aws_db_instance.${secret}`], firewallChanges: [secret], unresolved: [`x:${secret}`] }),
    });
    assertNoCanaries(await evaluate(input), [secret], "policy decisions never echo externally derived text");
  });

  it("prototype-pollution keys and unknown fields are rejected by the strict schema and fail closed", async () => {
    for (const poison of [{ __proto__: { role: "admin" } }, { constructor: { prototype: { role: "admin" } } }, { toString: "x" }]) {
      const base = policyInputFor("service.restart");
      const viaParse = JSON.parse(JSON.stringify({ ...base, extra: poison })) as PolicyInput;
      Object.defineProperty(viaParse, "__proto__", { value: { role: "admin" }, enumerable: true, configurable: true });
      const r = await evaluate(viaParse);
      expect(r.decision.outcome).toBe("deny");
      expect(r.decision.reasons[0].code).toBe("policy_error");
    }
    expect(({} as Record<string, unknown>).role, "evaluating hostile input must not pollute Object.prototype").toBeUndefined();
  });

  it("numbers that are not numbers (NaN, Infinity, huge, negative zero) fail closed rather than compare", async () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e309, -1e309]) {
      const r = await evaluate(policyInputFor("infrastructure.apply", { principal: { role: "admin" }, plan: emptyPlanFacts({ costDeltaUsdMonthly: value, projectedMonthlyUsd: value }) }));
      expect(r.decision.outcome, String(value)).toBe("deny");
    }
  });
});

describe("P9: the bundle", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const repoWasm = path.join(process.cwd(), "policy", "dist", "policy.wasm");
  const repoManifest = path.join(process.cwd(), "policy", "dist", "manifest.json");
  const scratch = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zenith-sec-policy-"));
    dirs.push(dir);
    resetPolicyEngineCache();
    return dir;
  };

  it("loads the committed bundle and its version is the sha256 of the bytes the engine runs", () => {
    expect(engine.version).toBe(sha256Hex(readFileSync(repoWasm)));
  });

  it("a flipped byte, a truncated file, an empty file and a non-wasm file are each a load failure", async () => {
    const bytes = readFileSync(repoWasm);
    const variants: [string, Buffer][] = [
      ["flipped byte in the middle", Buffer.concat([bytes.subarray(0, 4000), Buffer.from([bytes[4000] ^ 0xff]), bytes.subarray(4001)])],
      ["truncated to half", bytes.subarray(0, Math.floor(bytes.length / 2))],
      ["empty", Buffer.alloc(0)],
      ["not wasm", Buffer.from("#!/bin/sh\necho allow\n")],
      ["wasm header only", bytes.subarray(0, 8)],
    ];
    for (const [name, content] of variants) {
      const dir = scratch();
      const wasm = path.join(dir, "policy.wasm");
      writeFileSync(wasm, content);
      copyFileSync(repoManifest, path.join(dir, "manifest.json"));
      await expect(loadPolicyEngine({ wasmPath: wasm }), name).rejects.toBeInstanceOf(PolicyLoadError);
    }
  });

  it("a manifest that names a different hash or a different entrypoint is a load failure", async () => {
    const good = JSON.parse(readFileSync(repoManifest, "utf8")) as Record<string, unknown>;
    for (const [name, patch] of [
      ["another hash", { wasmSha256: "0".repeat(64) }],
      ["another entrypoint", { entrypoint: "zenith/decision/other" }],
      ["a malformed hash", { wasmSha256: "not-a-hash" }],
    ] as const) {
      const dir = scratch();
      copyFileSync(repoWasm, path.join(dir, "policy.wasm"));
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ ...good, ...patch }));
      await expect(loadPolicyEngine({ wasmPath: path.join(dir, "policy.wasm") }), name).rejects.toBeInstanceOf(PolicyLoadError);
    }
    const dir = scratch();
    copyFileSync(repoWasm, path.join(dir, "policy.wasm"));
    writeFileSync(path.join(dir, "manifest.json"), "{ not json");
    await expect(loadPolicyEngine({ wasmPath: path.join(dir, "policy.wasm") })).rejects.toBeInstanceOf(PolicyLoadError);
  });

  it("a failed load is not cached as an engine: there is never a default-allow fallback", async () => {
    const dir = scratch();
    const wasm = path.join(dir, "policy.wasm");
    writeFileSync(wasm, Buffer.from("nope"));
    await expect(loadPolicyEngine({ wasmPath: wasm })).rejects.toBeInstanceOf(PolicyLoadError);
    copyFileSync(repoWasm, wasm);
    const repaired = await loadPolicyEngine({ wasmPath: wasm });
    expect((await repaired.evaluate(policyInputFor("service.restart"))).decision.outcome).toBe("allow");
  });

  it("CHARACTERIZATION: bundle integrity is a file-permission property, not a signature — a missing manifest loads whatever wasm is there", async () => {
    // Documented limit (threat model: policy bundle tampering). Anything that can write policy/dist can also rewrite
    // manifest.json; there is no pinned expected hash in configuration. The control is deploy-time: CI rebuilds the bundle
    // and fails on a diff, and the decision record stores the bundle sha256 so a swap is visible after the fact.
    const dir = scratch();
    const wasm = path.join(dir, "policy.wasm");
    copyFileSync(repoWasm, wasm);
    const noManifest = await loadPolicyEngine({ wasmPath: wasm });
    expect(noManifest.version).toBe(engine.version);
    // and the version it reports is of the bytes it actually ran, so a different bundle cannot impersonate this one's version
    expect(sha256Hex(readFileSync(wasm))).toBe(noManifest.version);
  });

  it("every capability in the catalog is covered by this suite's enumeration (a new capability is held to P1–P8 automatically)", () => {
    expect(caps.length).toBe(Object.keys(CAPABILITIES).length);
  });
});
