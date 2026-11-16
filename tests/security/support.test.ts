/**
 * The harness tests itself (WS-SEC).
 *
 * A security helper that silently passes is worse than none: a canary scanner
 * that cannot see a base64 leak makes every "no secret reached X" test a lie,
 * and a tenant matrix that cannot fail makes every isolation test vacuous. So
 * each helper is shown here to CATCH a planted defect of every kind it claims
 * to catch, and to stay quiet on clean input.
 */
import { describe, expect, it } from "vitest";
import {
  CANARY_SHAPES,
  assertNoCanaries,
  canaryRecord,
  canarySecret,
  canarySet,
  deepScanForCanaries,
  encodedForms,
  expectNoCanaries,
  injectionCorpus,
  injectionsFor,
  outcomeSignature,
  refused,
  tenantMatrix,
  type MatrixPrincipal,
  type MatrixTarget,
} from "../_support/security";

describe("canarySecret", () => {
  it("produces distinct, high-entropy values in the shape the label asks for", () => {
    const seen = new Set<string>();
    for (const shape of CANARY_SHAPES) {
      const a = canarySecret("same-label", shape);
      const b = canarySecret("same-label", shape);
      expect(a, `${shape}: two calls must differ`).not.toBe(b);
      seen.add(a).add(b);
      expect(canaryRecord(a)?.shape).toBe(shape);
    }
    expect(seen.size).toBe(CANARY_SHAPES.length * 2);
  });

  it("matches the real-world shapes the redactors look for", () => {
    const c = canarySet("shape");
    expect(c["aws-access-key-id"]).toMatch(/^AKIA[A-Z2-7]{16}$/);
    expect(c["aws-secret-access-key"]).toMatch(/^[A-Za-z0-9/+]{40}$/);
    expect(c["aws-session-token"]).toMatch(/^IQoJb3JpZ2luX2Vj[A-Za-z0-9/+]{340}$/);
    expect(c.jwt).toMatch(/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]{300,}$/);
    expect(c["pem-private-key"]).toMatch(/^-----BEGIN PRIVATE KEY-----\n(?:[A-Za-z0-9/+]{1,64}\n)+-----END PRIVATE KEY-----$/);
    expect(c["zenith-agent-token"]).toMatch(/^za_[A-Za-z0-9_-]{43}$/);
    expect(c["github-token"]).toMatch(/^ghp_[A-Za-z0-9]{36}$/);
    expect(c["slack-token"]).toMatch(/^xoxb-\d{12}-[A-Za-z0-9]{24}$/);
    expect(c["hex-key"]).toMatch(/^[0-9a-f]{64}$/);
    expect(c.password.length).toBeGreaterThanOrEqual(20);
  });

  it("registers sub-parts so a partial leak of a PEM or JWT is still a hit", () => {
    const pem = canarySecret("pem", "pem-private-key");
    const firstBodyLine = pem.split("\n")[1];
    expect(deepScanForCanaries({ leaked: firstBodyLine }, [pem])).toHaveLength(1);
    const jwt = canarySecret("jwt", "jwt");
    const payload = jwt.split(".")[1];
    expect(deepScanForCanaries(`claims: ${payload}`, [jwt])).toHaveLength(1);
  });
});

describe("deepScanForCanaries", () => {
  const secret = canarySecret("scan", "password");

  it("is quiet on clean input, including near misses", () => {
    expect(deepScanForCanaries({ a: [1, "two", { three: "four" }], b: null, c: undefined }, [secret])).toEqual([]);
    expect(deepScanForCanaries(secret.slice(0, -1), [secret])).toEqual([]);
    expect(deepScanForCanaries("", [secret])).toEqual([]);
    expect(deepScanForCanaries(undefined, [secret])).toEqual([]);
  });

  it("finds the raw value anywhere in nested objects, arrays, errors, maps, sets, keys and buffers", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    cyclic.deep = { deeper: [{ deepest: `prefix ${secret} suffix` }] };
    expect(deepScanForCanaries(cyclic, [secret]).map((h) => h.path)).toEqual(["$.deep.deeper[0].deepest"]);
    expect(deepScanForCanaries(new Error(`boom ${secret}`), [secret])[0]).toMatchObject({ where: "error", form: "raw" });
    const withCause = new Error("outer", { cause: new Error(`inner ${secret}`) });
    expect(deepScanForCanaries(withCause, [secret]).length).toBeGreaterThan(0);
    expect(deepScanForCanaries(new Map([["k", secret]]), [secret])).toHaveLength(1);
    expect(deepScanForCanaries(new Map([[secret, 1]]), [secret])).toHaveLength(1);
    expect(deepScanForCanaries(new Set([secret]), [secret])).toHaveLength(1);
    expect(deepScanForCanaries({ [secret]: true }, [secret])[0]).toMatchObject({ where: "key" });
    expect(deepScanForCanaries(Buffer.from(`xx${secret}yy`), [secret])[0]).toMatchObject({ where: "bytes" });
    expect(deepScanForCanaries({ toJSON: () => ({ hidden: secret }) }, [secret])).toHaveLength(1);
  });

  it("finds every encoded form it claims to: json, url, form, hex, percent-all, base64 and base64url at any alignment", () => {
    const pw = canarySecret("encodings", "password");
    const pem = canarySecret("encodings-pem", "pem-private-key");
    for (const value of [pw, pem]) {
      for (const f of encodedForms(value)) {
        const hits = deepScanForCanaries({ wrapped: `x${f.text}y` }, [value]);
        expect(hits.map((h) => h.form), `form ${f.form} of a ${canaryRecord(value)?.shape} must be found`).toContain(f.form);
      }
    }
  });

  it("finds a canary base64-encoded inside a larger buffer at each of the three alignments", () => {
    const pw = canarySecret("b64-align", "password");
    for (const pad of ["", "a", "ab"]) {
      const blob = Buffer.from(`${pad}${pw}::trailer`).toString("base64");
      expect(deepScanForCanaries(blob, [pw]).length, `alignment with ${pad.length} leading bytes`).toBeGreaterThan(0);
      const urlBlob = Buffer.from(`${pad}${pw}::trailer`).toString("base64url");
      expect(deepScanForCanaries(urlBlob, [pw]).length, `url-safe alignment with ${pad.length} leading bytes`).toBeGreaterThan(0);
    }
  });

  it("decodes a percent-encoded string once more and scans it (double-encoding evasion)", () => {
    const pw = canarySecret("pct", "password");
    expect(deepScanForCanaries(`q=${encodeURIComponent(`a b ${pw}`)}`, [pw]).length).toBeGreaterThan(0);
  });

  it("detects truncation when asked for fragments (a redactor that keeps a prefix)", () => {
    const tok = canarySecret("fragment", "aws-secret-access-key");
    expect(deepScanForCanaries(`${tok.slice(0, 16)}…`, [tok])).toEqual([]);
    expect(deepScanForCanaries(`${tok.slice(0, 16)}…`, [tok], { fragmentLength: 12 }).map((h) => h.form)).toContain("fragment");
  });

  it("refuses a canary too short to scan for safely", () => {
    expect(() => deepScanForCanaries("abc", ["abc"])).toThrow(/too short/);
  });

  it("reports a hit once per location and never prints the whole secret", () => {
    const hits = deepScanForCanaries({ a: secret }, [secret, secret]);
    expect(hits).toHaveLength(1);
    expect(JSON.stringify(hits)).not.toContain(secret);
  });

  it("expectNoCanaries throws naming the invariant", () => {
    const hits = deepScanForCanaries({ leak: secret }, [secret]);
    expect(() => expectNoCanaries(hits, "plan views carry no secrets")).toThrow(/SECURITY INVARIANT VIOLATED: plan views carry no secrets/);
    expect(() => assertNoCanaries({ fine: 1 }, [secret], "x")).not.toThrow();
  });
});

describe("tenantMatrix", () => {
  const workspaces = ["ws-a", "ws-b"];
  const principals: MatrixPrincipal[] = [
    { id: "alice", workspaceId: "ws-a" },
    { id: "bob", workspaceId: "ws-b" },
  ];
  const targets: MatrixTarget[] = [
    { id: "obj-a-0001", workspaceId: "ws-a", kind: "obj" },
    { id: "obj-b-0001", workspaceId: "ws-b", kind: "obj" },
    { id: "obj-ghost-1", workspaceId: null, kind: "obj" },
  ];
  const owner: Record<string, string | undefined> = { "obj-a-0001": "ws-a", "obj-b-0001": "ws-b" };

  /** A correct, well-behaved implementation: foreign and phantom look the same. */
  const good = (p: MatrixPrincipal, t: MatrixTarget) => {
    if (owner[t.id] !== p.workspaceId) throw Object.assign(new Error(`No such object ${t.id}.`), { code: "not_found", status: 404 });
    return { id: t.id };
  };

  it("passes a correct implementation and renders a readable table", async () => {
    const m = await tenantMatrix({ label: "good", workspaces, principals, targets, call: good });
    expect(() => m.assertIsolated()).not.toThrow();
    expect(m.table()).toContain("alice@ws-a");
    expect(m.table()).toMatch(/allowed\s+not_found:not_found\s+not_found:not_found/);
  });

  it("catches a cross-tenant success", async () => {
    const m = await tenantMatrix({ label: "leaky", workspaces, principals, targets, call: (_p, t) => (t.workspaceId === null ? good(_p, t) : { id: t.id }) });
    expect(() => m.assertIsolated()).toThrow(/CROSS-TENANT ACCESS: alice@ws-a -> obj-b-0001/);
  });

  it("catches a phantom that succeeds", async () => {
    const m = await tenantMatrix({ label: "phantom", workspaces, principals, targets, call: (p, t) => (t.workspaceId === null ? { id: "made up" } : good(p, t)) });
    expect(() => m.assertIsolated()).toThrow(/PHANTOM SUCCEEDED/);
  });

  it("catches an own target that is refused (a matrix that refuses everything proves nothing)", async () => {
    const m = await tenantMatrix({ label: "deny-all", workspaces, principals, targets, call: () => refused("forbidden", { code: "denied" }) });
    expect(() => m.assertIsolated()).toThrow(/OWN TARGET REFUSED/);
    expect(() => m.assertIsolated({ ownMustSucceed: false })).not.toThrow();
  });

  it("catches an uninterpretable refusal (a 500 or a validation error is not a refusal)", async () => {
    const m = await tenantMatrix({
      label: "crashy",
      workspaces,
      principals,
      targets,
      call: (p, t) => {
        if (owner[t.id] !== p.workspaceId) throw Object.assign(new Error("kaboom"), { status: 500 });
        return { id: t.id };
      },
    });
    expect(() => m.assertIsolated({ noExistenceLeak: false })).toThrow(/UNINTERPRETABLE REFUSAL/);
  });

  it("catches an existence oracle: foreign and phantom refused differently", async () => {
    const m = await tenantMatrix({
      label: "oracle",
      workspaces,
      principals,
      targets,
      call: (p, t) => {
        if (t.workspaceId === null) throw Object.assign(new Error("not found"), { code: "not_found", status: 404 });
        if (owner[t.id] !== p.workspaceId) throw Object.assign(new Error("not yours"), { code: "forbidden", status: 403 });
        return { id: t.id };
      },
    });
    expect(() => m.assertIsolated()).toThrow(/EXISTENCE LEAK/);
    expect(() => m.assertIsolated({ noExistenceLeak: false })).not.toThrow();
    // narrowing the allowed outcomes to not_found makes the 403 a violation of its own
    expect(() => m.assertIsolated({ noExistenceLeak: false, allowedCrossTenantOutcomes: ["not_found"] })).toThrow(/UNINTERPRETABLE REFUSAL/);
  });

  it("ignores ids echoed in messages when comparing refusals", () => {
    const a = outcomeSignature({ kind: "not_found", message: "Project prj-1 does not exist" }, ["prj-1", "prj-2"]);
    const b = outcomeSignature({ kind: "not_found", message: "Project prj-2 does not exist" }, ["prj-1", "prj-2"]);
    expect(a).toBe(b);
  });

  it("catches a foreign canary in a SUCCESSFUL response (a list that returns somebody else's row)", async () => {
    const planted = canarySecret("bob-secret", "password");
    const m = await tenantMatrix({
      label: "list-leak",
      workspaces,
      principals,
      targets: [{ id: "*", workspaceId: "ws-a", kind: "list" }],
      call: () => ({ rows: [{ mine: "x" }, { theirs: planted }] }),
    });
    expect(() => m.assertIsolated({ canariesByWorkspace: { "ws-b": [planted] }, ownMustSucceed: false })).toThrow(/FOREIGN SECRET DELIVERED: alice@ws-a/);
  });

  it("marks an attack principal that owns nothing: own targets must be refused too", async () => {
    const attack: MatrixPrincipal[] = [...principals, { id: "revoked", workspaceId: "ws-a", ownAccess: "none" }];
    const m = await tenantMatrix({ label: "revoked", workspaces, principals: attack, targets, call: good });
    expect(() => m.assertIsolated()).toThrow(/REVOKED PRINCIPAL SUCCEEDED: revoked@ws-a -> obj-a-0001/);
  });

  it("rejects a spec that names a workspace it did not declare", async () => {
    await expect(tenantMatrix({ label: "bad", workspaces: ["ws-a"], principals, targets, call: good })).rejects.toThrow(/unknown workspace "ws-b"/);
  });

  it("classifies the refusal styles modules actually use", async () => {
    const styles: [unknown, string][] = [
      [Object.assign(new Error("x"), { status: 404 }), "not_found"],
      [Object.assign(new Error("x"), { code: "operation_not_found" }), "not_found"],
      [Object.assign(new Error("x"), { code: "scope_denied", status: 403 }), "forbidden"],
      [Object.assign(new Error("x"), { code: "membership_denied" }), "forbidden"],
      [new Error('Project "prj-1" does not exist. Pick one from the workspace overview.'), "not_found"],
      [Object.assign(new Error("x"), { code: "invalid_arguments", status: 400 }), "other_refusal"],
    ];
    for (const [error, expected] of styles) {
      const m = await tenantMatrix({
        label: "classify",
        workspaces,
        principals: [principals[0]],
        targets: [{ id: "obj-b-0001", workspaceId: "ws-b" }],
        call: () => {
          throw error;
        },
      });
      expect(m.cells[0].outcome.kind, String((error as Error).message)).toBe(expected);
    }
  });
});

describe("injectionCorpus", () => {
  it("covers every category the brief lists", () => {
    const categories = new Set(injectionCorpus.map((c) => c.category));
    for (const needed of ["prompt-injection", "shell", "path-traversal", "ansi", "nul", "unicode-bidi", "zero-width", "oversized", "json-breakout", "yaml-breakout", "hcl"] as const) {
      expect(categories.has(needed), needed).toBe(true);
    }
  });

  it("has stable unique ids and non-empty values", () => {
    const ids = injectionCorpus.map((c) => c.id);
    // ids are `<category>/<slug>`; a duplicate would make a failing case ambiguous
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of injectionCorpus) expect(c.value.length, c.id).toBeGreaterThan(0);
  });

  it("contains the oversized entries and lets a slow sink skip them", () => {
    expect(injectionsFor("oversized").some((c) => c.value.length > 1024 * 1024)).toBe(true);
    expect(injectionsFor("shell", "nul").every((c) => c.category === "shell" || c.category === "nul")).toBe(true);
    expect(injectionsFor().length).toBe(injectionCorpus.length);
  });

  it("is inert: every URL in a payload points at a reserved, loopback, link-local or IP-literal host", () => {
    const hostOf = /\b(?:https?|gopher|file):\/\/(?:[^@/\s]*@)?\[?([^/\s:\][\u0000-\u001f]*)/gi;
    const inert = /(?:\.invalid|\.example|^localhost\.?|^metadata\.google\.internal|^[0-9a-fx.]*)$/i;
    for (const c of injectionCorpus) {
      if (c.category === "oversized") continue;
      for (const m of c.value.matchAll(hostOf)) expect(inert.test(m[1]), `${c.id}: host "${m[1]}" is not an inert one`).toBe(true);
    }
  });
});
