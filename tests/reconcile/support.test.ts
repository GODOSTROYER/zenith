import { describe, expect, it } from "vitest";
import { describeError, isAccessDenied, redactText, scrubValue } from "@/lib/reconcile";
import { fnv1a, mapPool, raceTimeout, TimeoutError } from "@/lib/reconcile/util";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";

describe("redactText", () => {
  it("replaces every credential shape and keeps the rest readable", () => {
    const text = `failed for AKIAIOSFODNN7EXAMPLE: Bearer abcdefghijklmnopqrstuvwxyz0123; url postgres://admin:s3cr3t@db.internal/app; password=hunter2; ${PEM}; jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk`;
    const out = redactText(text, 2000);
    for (const secret of ["AKIAIOSFODNN7EXAMPLE", "abcdefghijklmnopqrstuvwxyz0123", "s3cr3t", "hunter2", "MIIEowIBAAKCAQEA", "eyJzdWIi"]) expect(out).not.toContain(secret);
    expect(out).toContain("failed for");
    expect(out).toContain("db.internal");
  });

  it("collapses whitespace and control characters (an error message cannot forge log lines) and bounds the length", () => {
    expect(redactText("a\n\nb\tc\u0000d", 50)).toBe("a b c d");
    const long = redactText("x ".repeat(500), 100);
    expect(long.length).toBeLessThanOrEqual(101);
    expect(long.endsWith("…")).toBe(true);
  });

  it("leaves ARNs, ids and short identifiers alone", () => {
    const arn = "arn:aws:ecs:us-east-1:123456789012:service/cluster-prod/web-7f3a9c";
    expect(redactText(`cannot read ${arn}`)).toBe(`cannot read ${arn}`);
  });
});

describe("scrubValue", () => {
  it("replaces credential shapes inside nested strings and leaves everything else byte for byte", () => {
    const digest = "a".repeat(64);
    const input = { image: `ghcr.io/acme/app@sha256:${digest}`, arn: "arn:aws:iam::123456789012:role/x", n: 3, ok: true, none: null, nested: { list: ["AKIAIOSFODNN7EXAMPLE", "plain", PEM], url: "https://user:pw@host/x" } };
    const out = scrubValue(input);
    expect(out.image).toBe(input.image); // an image digest is not a credential
    expect(out.arn).toBe(input.arn);
    expect(out.n).toBe(3);
    expect(out.none).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/AKIAIOSFODNN7EXAMPLE|user:pw|BEGIN RSA/);
    expect(out.nested.list[1]).toBe("plain");
    expect(input.nested.list[0]).toBe("AKIAIOSFODNN7EXAMPLE"); // the input was not mutated
  });

  it("is bounded: a hostile, deeply nested value cannot make it expensive", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 100; i++) deep = { child: deep };
    expect(JSON.stringify(scrubValue(deep))).toContain("[truncated]");
    const wide = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, "v"]));
    expect(Object.keys(scrubValue(wide)).length).toBe(20_000);
  });
});

describe("error classification", () => {
  it("recognises access denial by name, code and status, and nothing else", () => {
    for (const e of [
      Object.assign(new Error("x"), { name: "AccessDeniedException" }),
      Object.assign(new Error("x"), { code: "UnauthorizedOperation" }),
      Object.assign(new Error("x"), { code: "credential_denied" }),
      Object.assign(new Error("x"), { $metadata: { httpStatusCode: 403 } }),
      Object.assign(new Error("x"), { status: 401 }),
      Object.assign(new Error("x"), { name: "ExpiredTokenException" }),
      new Error("User is not authorized to perform ecs:DescribeServices"),
    ])
      expect(isAccessDenied(e), String(e)).toBe(true);
    for (const e of [new Error("socket hang up"), Object.assign(new Error("slow"), { name: "ThrottlingException" }), Object.assign(new Error("x"), { $metadata: { httpStatusCode: 500 } }), new TimeoutError(10), "boom", null, undefined, 42])
      expect(isAccessDenied(e), String(e)).toBe(false);
  });

  it("describes an error as 'Code: scrubbed message' — no stack, no cause", () => {
    const err = Object.assign(new Error("denied for AKIAIOSFODNN7EXAMPLE"), { name: "AccessDenied", cause: new Error("inner secret=abc") });
    const text = describeError(err);
    expect(text).toBe("AccessDenied: denied for [redacted-key-id]");
    expect(text).not.toMatch(/at |inner|abc/);
    expect(describeError(null)).toBe("unknown error");
    expect(describeError("plain string token=xyz")).toBe("plain string token=[redacted]");
  });
});

describe("mapPool", () => {
  it("preserves order, bounds concurrency and handles empty and oversized limits", async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapPool([5, 1, 4, 2, 3], 2, async (n) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(max).toBe(2);
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
    expect(await mapPool([1, 2], 99, async (n) => n)).toEqual([1, 2]);
    expect(await mapPool([1, 2], 0, async (n) => n)).toEqual([1, 2]); // a nonsense limit still makes progress
  });
});

describe("raceTimeout", () => {
  it("resolves and rejects like the work, and aborts the signal on timeout", async () => {
    expect(await raceTimeout(async () => "ok", 100)).toBe("ok");
    await expect(raceTimeout(async () => Promise.reject(new Error("nope")), 100)).rejects.toThrow("nope");
    let seen: AbortSignal | undefined;
    await expect(raceTimeout((signal) => ((seen = signal), new Promise<never>(() => undefined)), 20)).rejects.toBeInstanceOf(TimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  it("a late rejection after the timeout is swallowed, never an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(raceTimeout(() => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 40)), 10)).rejects.toBeInstanceOf(TimeoutError);
      await new Promise((r) => setTimeout(r, 80));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a zero budget never calls the work, and a parent abort cancels it", async () => {
    let called = false;
    await expect(raceTimeout(async () => ((called = true), 1), 0)).rejects.toBeInstanceOf(TimeoutError);
    expect(called).toBe(false);
    const parent = new AbortController();
    const pending = raceTimeout((signal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))), 5_000, parent.signal);
    parent.abort(new Error("lease lost"));
    await expect(pending).rejects.toThrow("lease lost");
    await expect(raceTimeout(async () => 1, 100, parent.signal)).rejects.toThrow("lease lost");
  });
});

describe("fnv1a", () => {
  it("is a stable 32-bit hash", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("reconcile:env-1")).toBe(fnv1a("reconcile:env-1"));
    expect(fnv1a("x")).toBeLessThanOrEqual(0xffffffff);
  });
});
