/**
 * The one canonical-JSON + SHA-256 rule (src/lib/controlplane/digest.ts) under
 * attack (WS-SEC).
 *
 * Everything the control plane binds — a proposal digest an approver reviewed, a
 * policy input digest, an OpenTofu plan digest, a capability grant's bound digest
 * — is `digest(value)`. Approvals are digest-bound (invariant 5): if two
 * different requests can share a digest, an approval for one authorizes the
 * other; if one request can have two digests, an approval can be made to miss.
 * So the properties that matter are exactly the ones a serializer is worst at:
 *
 *   stability      the same logical value always gives the same digest, whatever
 *                  order its keys were built in;
 *   injectivity    distinct JSON values give distinct digests;
 *   no pollution   `__proto__`, `constructor`, `prototype` are ordinary data;
 *   honesty        the things `canonical` does NOT do are pinned, so nobody
 *                  assumes otherwise: no Unicode normalization, non-JSON values
 *                  collapse, and there is no domain separation between purposes.
 *
 * "Documented limit" tests state today's behaviour as a contract for CALLERS:
 * whatever reaches `digest()` must be a plain JSON value.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonical, digest, sha256Hex } from "@/lib/controlplane/digest";
import { configDigestOf } from "@/lib/tofu/config-digest";
import { assertWorkspaceIntact } from "@/lib/tofu/workspace";
import { stableJson } from "@/lib/tofu/stable";
import { builtinWorkspace, dataFragment } from "../tofu/_helpers";
import { skipIfJsonParseBroken } from "../_support/security";

/* ------------------------- a tiny deterministic fuzzer ------------------------- */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const KEYS = ["a", "b", "c", "id", "name", "__proto__", "constructor", "prototype", "toString", "é", "e\u0301", "", " ", "0", "00", "-1", "\u0000", "日本", "😀", "a b", "a\nb", '"', "\\", "$", "${x}"];
const STRINGS = ["", "x", "0", "null", "true", "{}", "[]", "é", "e\u0301", "\u202E", "\ud800", "\u2028", "a\"b", "a\\b", "line\nbreak", "日本語", "😀", "0".repeat(40)];

function randomJson(next: () => number, depth = 0): Json {
  const r = next();
  if (depth > 4 || r < 0.35) {
    const p = next();
    if (p < 0.15) return null;
    if (p < 0.3) return next() < 0.5;
    if (p < 0.55) return [0, 1, -1, 0.5, 1e21, 1e-7, 9007199254740991, -0][Math.floor(next() * 8)];
    return STRINGS[Math.floor(next() * STRINGS.length)];
  }
  if (r < 0.65) return Array.from({ length: Math.floor(next() * 4) }, () => randomJson(next, depth + 1));
  const obj: { [k: string]: Json } = {};
  for (let i = Math.floor(next() * 4); i >= 0; i--) {
    // own data property even for __proto__ (defineProperty, like JSON.parse does)
    Object.defineProperty(obj, KEYS[Math.floor(next() * KEYS.length)], { value: randomJson(next, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return obj;
}

/** Same value, every object's keys inserted in a different (shuffled) order. */
function reshuffle(value: Json, next: () => number): Json {
  if (Array.isArray(value)) return value.map((v) => reshuffle(v, next));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }
    const out: { [k: string]: Json } = {};
    for (const [k, v] of entries) Object.defineProperty(out, k, { value: reshuffle(v, next), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return value;
}

describe("stability", () => {
  it("is invariant under key reordering at every depth (2,000 random values x shuffles)", () => {
    const next = rng(42);
    for (let i = 0; i < 2000; i++) {
      const v = randomJson(next);
      const w = reshuffle(v, next);
      expect(canonical(w), `value #${i}`).toBe(canonical(v));
      expect(digest(w)).toBe(digest(v));
    }
  });

  it("keeps array order significant (an approval for [a,b] is not an approval for [b,a])", () => {
    expect(digest([1, 2, 3])).not.toBe(digest([3, 2, 1]));
    expect(digest({ steps: ["plan", "apply"] })).not.toBe(digest({ steps: ["apply", "plan"] }));
  });

  it("drops undefined members of objects but keeps null, and does both the same way at every depth", () => {
    expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }));
    expect(canonical({ a: 1, b: null })).not.toBe(canonical({ a: 1 }));
    expect(canonical({ x: { y: undefined, z: 1 } })).toBe(canonical({ x: { z: 1 } }));
  });

  it("round-trips: parsing the canonical form gives back the same value", (ctx) => {
    // needs a faithful JSON.parse: on Node 24.x (V8 13.6) this is skipped, loudly, with the defect named
    skipIfJsonParseBroken(ctx);
    const next = rng(7);
    for (let i = 0; i < 2000; i++) {
      const v = randomJson(next);
      const again = JSON.parse(canonical(v)) as Json;
      expect(canonical(again), `value #${i}`).toBe(canonical(v));
    }
  });

  it("is what it says it is: SHA-256 hex of the canonical form; sha256Hex agrees for strings and bytes", () => {
    const v = { b: [1, { d: 2, c: 3 }], a: "x" };
    expect(canonical(v)).toBe('{"a":"x","b":[1,{"c":3,"d":2}]}');
    expect(digest(v)).toBe(createHash("sha256").update('{"a":"x","b":[1,{"c":3,"d":2}]}').digest("hex"));
    expect(sha256Hex("héllo")).toBe(sha256Hex(Buffer.from("héllo", "utf8")));
    expect(digest(v)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("injectivity: distinct JSON values never share a digest", () => {
  it("finds no collision among 4,000 random values (equal canonical form implies equal value)", () => {
    const next = rng(1234);
    const seen = new Map<string, Json>();
    const normalize = (v: Json): Json => (Array.isArray(v) ? v.map(normalize) : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, normalize(x)])) : v);
    let distinct = 0;
    for (let i = 0; i < 4000; i++) {
      const v = randomJson(next);
      const c = canonical(v);
      const prior = seen.get(c);
      if (prior === undefined) {
        seen.set(c, v);
        distinct++;
      } else {
        expect(JSON.stringify(normalize(v)), `canonical form ${c.slice(0, 60)} shared by two different values`).toBe(JSON.stringify(normalize(prior)));
      }
    }
    expect(distinct).toBeGreaterThan(1500);
  });

  it("every single-leaf mutation changes the digest", () => {
    const base = { op: "deploy", target: { env: "prod", region: "us-east-1" }, flags: [true, false], n: 3, note: null };
    const mutations: Json[] = [
      { ...base, op: "rollback" },
      { ...base, target: { env: "prod", region: "eu-west-1" } },
      { ...base, flags: [true, true] },
      { ...base, n: 4 },
      { ...base, note: "" },
      { ...base, extra: 0 },
      { ...base, n: "3" },
      { ...base, flags: [true, false, false] },
      { ...base, target: { env: "prod " , region: "us-east-1" } },
    ];
    const seen = new Set([digest(base)]);
    for (const m of mutations) {
      const d = digest(m);
      expect(seen.has(d), `mutation ${JSON.stringify(m)} collided`).toBe(false);
      seen.add(d);
    }
  });

  it("types are not confused: 1, '1', true, [1], {a:1}, null and '' all differ", () => {
    const values: Json[] = [1, "1", true, [1], { a: 1 }, null, "", [], {}, 0, false, "null", "true"];
    expect(new Set(values.map(digest)).size).toBe(values.length);
  });

  it("separators cannot be forged from inside strings or keys", () => {
    expect(digest({ a: "b", c: "d" })).not.toBe(digest({ a: 'b","c":"d' }));
    expect(digest(["a", "b"])).not.toBe(digest(["a,b"]));
    expect(digest({ "a:b": 1 })).not.toBe(digest({ a: { b: 1 } }));
    expect(digest({ 'a":1,"b': 2 })).not.toBe(digest({ a: 1, b: 2 }));
  });
});

describe("prototype-pollution keys are ordinary data", () => {
  it("__proto__, constructor and prototype are hashed as own keys, sorted with the others", () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"prototype":1,"a":1}') as Json;
    expect(canonical(parsed)).toBe('{"__proto__":{"polluted":true},"a":1,"constructor":{"prototype":{"x":1}},"prototype":1}');
    expect(digest(parsed)).not.toBe(digest({ a: 1 }));
  });

  it("digesting hostile input never pollutes Object.prototype", () => {
    digest(JSON.parse('{"__proto__":{"polluted":"yes"},"a":{"__proto__":{"also":"yes"}}}'));
    digest(JSON.parse('{"constructor":{"prototype":{"polluted":"yes"}}}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).also).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("a value that differs only in its __proto__ member has a different digest", () => {
    const a = JSON.parse('{"__proto__":{"role":"admin"},"user":"u1"}') as Json;
    const b = JSON.parse('{"__proto__":{"role":"viewer"},"user":"u1"}') as Json;
    const c = JSON.parse('{"user":"u1"}') as Json;
    expect(new Set([digest(a), digest(b), digest(c)]).size).toBe(3);
  });

  it("DOCUMENTED LIMIT: an object LITERAL `{ __proto__: x }` sets the prototype, is not an own key, and is therefore not hashed — callers must build hashed values from JSON, never from literals carrying __proto__", () => {
    const literal = { __proto__: { role: "admin" }, user: "u1" } as unknown as Json;
    expect(digest(literal)).toBe(digest({ user: "u1" }));
  });
});

describe("what canonical() does not do (documented limits, pinned)", () => {
  it("does NOT normalize Unicode: NFC and NFD forms, homoglyphs and invisible characters are different values", () => {
    const pairs: [string, string][] = [
      ["é", "e\u0301"], // é NFC vs NFD
      ["admin", "аdmin"], // Cyrillic a
      ["admin", "ad\u200Bmin"], // zero-width space
      ["admin", "\uFF41\uFF44\uFF4D\uFF49\uFF4E"], // fullwidth (NFKC-equal)
      ["abc", "abc\u202E"], // bidi override
    ];
    for (const [a, b] of pairs) {
      expect(digest(a), JSON.stringify([a, b])).not.toBe(digest(b));
      expect(digest({ [a]: 1 })).not.toBe(digest({ [b]: 1 }));
    }
    // and lone surrogates stay distinct instead of collapsing to U+FFFD
    expect(digest("\ud800")).not.toBe(digest("\ud801"));
    expect(digest("\ud800")).not.toBe(digest("�"));
  });

  it("collapses non-JSON values the way JSON.stringify does inside arrays: callers must pass plain JSON", () => {
    // these are NOT injective; none may reach digest() from untrusted input
    expect(digest({ d: new Date(0) })).toBe(digest({ d: {} }));
    expect(digest({ d: new Date(0) })).toBe(digest({ d: new Date(1e12) }));
    expect(digest(new Map([["a", 1]]))).toBe(digest({}));
    expect(digest(new Set([1, 2]))).toBe(digest({}));
    expect(digest({ n: Number.NaN })).toBe(digest({ n: null }));
    expect(digest({ n: Number.POSITIVE_INFINITY })).toBe(digest({ n: null }));
    expect(digest({ n: -0 })).toBe(digest({ n: 0 }));
    expect(digest([undefined])).toBe(digest([null]));
    expect(digest({ f: () => 1 })).toBe(digest({ f: null }));
    expect(digest({ s: Symbol("x") })).toBe(digest({ s: null }));
    expect(canonical({ x: { toJSON: () => "t" } })).toBe('{"x":{"toJSON":null}}');
  });

  it("throws (never hangs, never silently truncates) on values it cannot serialize", () => {
    expect(() => digest({ n: 10n })).toThrow(/BigInt/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => digest(cyclic)).toThrow(RangeError);
    // a hostile, deeply nested value from an untrusted body fails cleanly with a stack error, not a crash
    let deep: unknown = "x";
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(() => digest(deep)).toThrow(RangeError);
  });

  it("has no domain separation: two purposes hashing the same value get the same digest", () => {
    // the approval, grant and policy-input digests are all `digest(value)`; what keeps them apart is that each is bound
    // next to an id (operation id, grant jti, decision id), never that their digests differ. Pinned so nobody assumes otherwise.
    const value = { capability: "service.restart", scope: { workspaceId: "ws_1" } };
    expect(digest(value)).toBe(sha256Hex(canonical(value)));
    expect(digest(value)).toBe(digest(structuredClone(value)));
  });
});

describe("configDigestOf: the workspace identity rule (path, content, order)", () => {
  const f = (path: string, content: string) => ({ path, content });

  it("does not depend on the order files are supplied in", () => {
    const a = [f("a.tf.json", "1"), f("b.tf.json", "2"), f("c/d.tf.json", "3")];
    expect(configDigestOf([...a].reverse())).toBe(configDigestOf(a));
  });

  it("is sensitive to every byte of every file, to every path, and to which file holds which content", () => {
    const base = [f("a.tf.json", "one"), f("b.tf.json", "two")];
    const d = configDigestOf(base);
    expect(configDigestOf([f("a.tf.json", "one"), f("b.tf.json", "twp")])).not.toBe(d);
    expect(configDigestOf([f("a.tf.json", "two"), f("b.tf.json", "one")]), "swapping contents between files").not.toBe(d);
    expect(configDigestOf([f("a2.tf.json", "one"), f("b.tf.json", "two")]), "renaming a file").not.toBe(d);
    expect(configDigestOf([...base, f("c.tf.json", "")]), "adding an empty file").not.toBe(d);
    expect(configDigestOf(base.slice(0, 1)), "removing a file").not.toBe(d);
  });

  it("framing is unambiguous: moving bytes between a path and its content cannot keep the digest", () => {
    expect(configDigestOf([f("ab", "c")])).not.toBe(configDigestOf([f("a", "bc")]));
    expect(configDigestOf([f("a", ""), f("b", "x")])).not.toBe(configDigestOf([f("a", "b"), f("x", "")]));
    // the per-file digest is of the content, so a content that looks like the next record cannot forge it
    const forged = `x\n${"b".padEnd(1)}\u0000${sha256Hex("y")}\n`;
    expect(configDigestOf([f("a", forged)])).not.toBe(configDigestOf([f("a", "x"), f("b", "y")]));
  });

  it("an assembled workspace's digest is recomputed from its bytes, and a duplicate path or an edited byte is refused", () => {
    const ws = builtinWorkspace("/tmp/x/terraform.tfstate", { "resource/a": dataFragment("a", "v") });
    expect(() => assertWorkspaceIntact(ws)).not.toThrow();
    expect(() => assertWorkspaceIntact({ ...ws, files: [...ws.files, ws.files[0]] })).toThrow(/Duplicate/);
    expect(() => assertWorkspaceIntact({ ...ws, files: ws.files.map((x, i) => (i === 1 ? { ...x, content: `${x.content} ` } : x)) })).toThrow(/configDigest/);
    expect(() => assertWorkspaceIntact({ ...ws, lockfile: `${ws.lockfile}# edited\n` })).toThrow(/lockDigest/);
  });

  it("stableJson sorts keys the way canonical() does, so files built from differently ordered fragments are byte-identical", (ctx) => {
    skipIfJsonParseBroken(ctx);
    const next = rng(99);
    for (let i = 0; i < 300; i++) {
      const v = randomJson(next);
      expect(stableJson(reshuffle(v, next))).toBe(stableJson(v));
      expect(JSON.stringify(JSON.parse(stableJson(v)))).toBe(JSON.stringify(JSON.parse(stableJson(reshuffle(v, next)))));
    }
  });
});
