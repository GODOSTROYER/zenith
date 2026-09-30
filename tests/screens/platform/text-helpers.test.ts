import { describe, expect, it } from "vitest";
import {
  describeSpan,
  flattenObject,
  formatScalar,
  humanizeToken,
  isSecretReference,
  isSecretishPath,
  plural,
  sameValue,
  shortDigest,
  stableStringify,
  toPercent,
  truncate,
} from "@/components/platform/text";

describe("shortDigest", () => {
  it("shortens a hex digest and strips a sha256: prefix", () => {
    expect(shortDigest("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08")).toBe("9f86d081884c");
    expect(shortDigest("sha256:9f86d081884c7d659a2f", 8)).toBe("9f86d081");
  });
  it("leaves a short value alone", () => {
    expect(shortDigest("abc")).toBe("abc");
  });
});

describe("humanizeToken", () => {
  it.each([
    ["target_unhealthy", "Target unhealthy"],
    ["drift.repair", "Drift repair"],
    ["maxWindowHours", "Max window hours"],
    ["a-b:c", "A b c"],
  ])("%s -> %s", (input, out) => expect(humanizeToken(input)).toBe(out));
  it("never returns an empty string for a non-empty token", () => {
    expect(humanizeToken("___")).toBe("___");
  });
});

describe("secret-looking paths", () => {
  it.each(["password", "db_password", "api_key", "AWS_SECRET_ACCESS_KEY", "auth_token", "private_key", "connection_string", "credentials.value"])(
    "%s is treated as secret",
    (p) => expect(isSecretishPath(p)).toBe(true)
  );
  it.each(["replicas", "image", "health.path", "desired_count"])("%s is not", (p) => expect(isSecretishPath(p)).toBe(false));
  it("recognises a reference as not being a value", () => {
    expect(isSecretReference("vault:web/db")).toBe(true);
    expect(isSecretReference("arn:aws:secretsmanager:us-east-1:123456789012:secret:x")).toBe(true);
    expect(isSecretReference("hunter2")).toBe(false);
    expect(isSecretReference(42)).toBe(false);
  });
});

describe("value comparison", () => {
  it("is structural and key-order independent", () => {
    expect(sameValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: "1" })).toBe(false);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue(null, undefined)).toBe(false);
  });
  it("drops undefined members like JSON", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe("formatScalar", () => {
  it("never renders an empty string as nothing", () => {
    expect(formatScalar("")).toBe('""');
    expect(formatScalar(null)).toBe("null");
  });
  it("truncates long text and compacts objects", () => {
    expect(formatScalar("x".repeat(500), 20)).toHaveLength(20);
    expect(formatScalar({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(formatScalar(false)).toBe("false");
  });
});

describe("flattenObject", () => {
  it("flattens nested plain objects to dotted paths and keeps arrays whole", () => {
    expect(flattenObject({ a: { b: 1, c: { d: 2 } }, e: [1, 2], f: {} })).toEqual({ "a.b": 1, "a.c.d": 2, e: [1, 2], f: {} });
  });
});

describe("small formatters", () => {
  it("pluralises", () => {
    expect(plural(1, "resource")).toBe("1 resource");
    expect(plural(2, "resource")).toBe("2 resources");
    expect(plural(2, "match", "matches")).toBe("2 matches");
  });
  it("truncates with an ellipsis within the limit", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
  });
  it("turns a 0..1 ratio into a clamped percentage, and refuses NaN", () => {
    expect(toPercent(0.82)).toBe(82);
    expect(toPercent(1.4)).toBe(100);
    expect(toPercent(-1)).toBe(0);
    expect(toPercent(Number.NaN)).toBeUndefined();
    expect(toPercent(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
  it("describes a span without false precision", () => {
    expect(describeSpan(20_000)).toBe("under a minute");
    expect(describeSpan(23 * 60_000)).toBe("23 minutes");
    expect(describeSpan(60_000)).toBe("1 minute");
    expect(describeSpan(65 * 60_000)).toBe("1 hour 5 minutes");
    expect(describeSpan(-5 * 60_000)).toBe("5 minutes");
    expect(describeSpan(49 * 3600_000)).toBe("2 days 1 hour");
  });
});
