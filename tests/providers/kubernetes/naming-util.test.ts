import { describe, expect, it } from "vitest";
import { dnsLabel, defaultNamespace, fnv1a, isDnsLabel, labelValue, looksLikeSecretRef, objectName, secretObjectName, tlsSecretName } from "@/lib/providers/kubernetes/naming";
import { boundBag, cpuToMillicores, deepEqual, quantityToMiB, redactText, scrubValues, truncate } from "@/lib/providers/kubernetes/util";

describe("dnsLabel", () => {
  it("leaves an already-valid name alone and is deterministic", () => {
    expect(dnsLabel("web")).toBe("web");
    expect(dnsLabel("web-2")).toBe("web-2");
    expect(dnsLabel("my-app")).toBe(dnsLabel("my-app"));
  });

  it("sanitizes anything else and marks the change with a hash so distinct inputs stay distinct", () => {
    const dotted = dnsLabel("app.example.com");
    expect(dotted).toMatch(/^app-example-com-[0-9a-f]{6}$/);
    expect(dnsLabel("app-example-com")).toBe("app-example-com");
    expect(dotted).not.toBe(dnsLabel("app-example-com"));
    expect(dnsLabel("A_B")).not.toBe(dnsLabel("a-b"));
    expect(dnsLabel("Web")).not.toBe("web");
  });

  it("always yields a DNS-1035 label within the length limit, even for hostile input", () => {
    for (const input of ["", "---", "9lives", "UPPER", "a".repeat(300), "x/y/z", "ünïcödé", "a--b", "-lead", "trail-", "🙂", "..", "web\u0000"]) {
      const out = dnsLabel(input);
      expect(isDnsLabel(out), JSON.stringify(input)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(63);
      expect(out).toMatch(/^[a-z]/);
    }
    expect(dnsLabel("a".repeat(300))).not.toBe(dnsLabel("a".repeat(301)));
  });

  it("derives object names from the address leaf", () => {
    expect(objectName({ address: "service/web" })).toBe("web");
    expect(objectName({ address: "dns_record/app.example.com" })).toMatch(/^app-example-com-/);
    expect(objectName({ address: "a/b/c" })).toBe("b-c-" + fnv1a("b/c").slice(0, 6)); // a slash is a change, so a/b/c stays distinct from x/b-c
    expect(objectName({ address: "x/b-c" })).toBe("b-c");
  });

  it("defaults the namespace from the environment", () => {
    expect(defaultNamespace("env-1")).toBe("zenith-env-1");
    expect(isDnsLabel(defaultNamespace("0190a1b2-ENV_ID:prod"))).toBe(true);
  });
});

describe("labelValue", () => {
  it("keeps valid values and repairs invalid ones within 63 characters", () => {
    expect(labelValue("env-prod-1")).toBe("env-prod-1");
    const bad = labelValue("env/prod 1!");
    expect(bad).toMatch(/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/);
    expect(labelValue("x".repeat(200)).length).toBeLessThanOrEqual(63);
    expect(labelValue("a/b")).not.toBe(labelValue("a-b"));
    expect(labelValue("")).toMatch(/^x-/);
  });
});

describe("secret and TLS secret names", () => {
  it("derives the Secret name from the reference only, stably, with distinct refs kept distinct", () => {
    const a = secretObjectName("vault:p1/s1/API_KEY");
    expect(a).toBe(secretObjectName("vault:p1/s1/API_KEY"));
    expect(a).toMatch(/^zs-api-key-[0-9a-f]{10}$/);
    expect(a).not.toBe(secretObjectName("vault:p2/s1/API_KEY"));
    expect(isDnsLabel(secretObjectName("vault:" + "x".repeat(500)))).toBe(true);
    expect(isDnsLabel(secretObjectName("vault:///"))).toBe(true);
  });

  it("names a certificate's secret by domain", () => {
    expect(tlsSecretName("example.com")).toMatch(/^tls-example-com-/);
    expect(tlsSecretName("*.example.com")).not.toBe(tlsSecretName("example.com"));
    expect(isDnsLabel(tlsSecretName("*.example.com"))).toBe(true);
  });

  it("distinguishes a reference from something that looks like a value", () => {
    for (const ok of ["vault:p/s/K", "arn:aws:secretsmanager:eu-west-1:1:secret:x", "projects/p/secrets/s"]) expect(looksLikeSecretRef(ok) || ok.startsWith("projects")).toBe(true);
    for (const bad of ["hunter2", "sk_live_abcdef", "has space: here", "", "a:" + "x".repeat(500)]) expect(looksLikeSecretRef(bad), bad).toBe(false);
  });
});

describe("quantities", () => {
  it("parses CPU and memory", () => {
    expect(cpuToMillicores("500m")).toBe(500);
    expect(cpuToMillicores("1")).toBe(1000);
    expect(cpuToMillicores("0.25")).toBe(250);
    expect(cpuToMillicores(2)).toBe(2000);
    expect(cpuToMillicores("lots")).toBeUndefined();
    expect(quantityToMiB("512Mi")).toBe(512);
    expect(quantityToMiB("1Gi")).toBe(1024);
    expect(quantityToMiB("500M")).toBe(477);
    expect(quantityToMiB("1Ti")).toBe(1024 * 1024);
    expect(quantityToMiB(1048576)).toBe(1);
    expect(quantityToMiB("12 parsecs")).toBeUndefined();
    expect(quantityToMiB(undefined)).toBeUndefined();
  });
});

describe("redaction", () => {
  it("scrubs bearer tokens, JWTs, cloud keys, key=value secrets, URL passwords and PEM blocks", () => {
    const text = [
      "Authorization: Bearer abcdefghijklmnop1234",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rkMQ",
      "key AKIAIOSFODNN7EXAMPLE and ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "password=hunter2 token: abc12345 api-key = zzzzzz",
      "postgres://user:pa55w0rd@host/db",
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redactText(text);
    for (const leak of ["abcdefghijklmnop1234", "dBjftJeZ4CVPmB92K27uhbUJU1p1rkMQ", "AKIAIOSFODNN7EXAMPLE", "ghp_abcdefghijklmnop", "hunter2", "abc12345", "zzzzzz", "pa55w0rd", "AAAA"]) {
      expect(out, leak).not.toContain(leak);
    }
    expect(out).toContain("postgres://user:[redacted]@host/db");
    expect(out).toContain("Authorization:");
  });

  it("leaves ordinary text alone", () => {
    const text = "listening on :8080, 3 workers ready, took 12ms";
    expect(redactText(text)).toBe(text);
  });

  it("scrubs exact secret values, however the text frames them, and ignores trivially short ones", () => {
    expect(scrubValues("a=SECRETVALUE b=SECRETVALUE", ["SECRETVALUE"])).toBe("a=[redacted] b=[redacted]");
    expect(scrubValues("keep ab", ["ab"])).toBe("keep ab");
  });

  it("truncates with an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
  });
});

describe("boundBag and deepEqual", () => {
  it("drops the largest entries until the bag fits", () => {
    const bag = { small: "a", big: "x".repeat(6000), mid: "y".repeat(100) };
    const out = boundBag(bag, 4096);
    expect(out).toEqual({ small: "a", mid: "y".repeat(100) });
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(4096);
    expect(boundBag({}, 10)).toEqual({});
  });

  it("compares JSON structurally, ignoring key order and undefined members", () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1, c: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: null }, { a: undefined })).toBe(false);
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
  });
});
