import { describe, expect, it } from "vitest";
import { asTemplate, inner, lit } from "@/lib/providers/gcp/hcl";
import { cloudName, gcpLabels, labelsMatch, networkTag, nodeLabels, parseTagDescription, tagDescription, tfLabel, tfSub, zenithTagged } from "@/lib/providers/gcp/naming";

describe("tfLabel", () => {
  it("sanitizes an address to [a-z0-9_]", () => {
    expect(tfLabel("service/web")).toBe("service_web");
    expect(tfLabel("dns_record/app.example.com")).toBe("dns_record_app_example_com");
    expect(tfLabel("Firewall/Web-To-DB")).toBe("firewall_web_to_db");
  });

  it("never returns an empty label or one starting with a digit, and strips hostile characters", () => {
    expect(tfLabel("///")).toBe("n");
    expect(tfLabel("1abc")).toBe("n_1abc");
    expect(tfLabel('x"; rm -rf /; ${file("/etc/passwd")}')).toMatch(/^[a-z0-9_]+$/);
  });

  it("adds suffixes for extra resources of one node", () => {
    expect(tfSub("service/web", "run")).toBe("service_web_run");
  });
});

describe("cloudName", () => {
  it("joins prefix and node name, lowercase, valid as a GCP id", () => {
    expect(cloudName("zn-env1", "service/Web_API", { max: 49 })).toBe("zn-env1-web-api");
  });

  it("truncates with a deterministic hash instead of cutting silently", () => {
    const long = `service/${"a".repeat(120)}`;
    const a = cloudName("zn-env1", long, { max: 49 });
    const b = cloudName("zn-env1", long, { max: 49 });
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(49);
    expect(a).toMatch(/^[a-z]([a-z0-9-]*[a-z0-9])?$/);
    expect(a).toMatch(/-[0-9a-f]{6}$/);
    const other = cloudName("zn-env1", `service/${"a".repeat(119)}b`, { max: 49 });
    expect(other).not.toBe(a);
  });

  it("starts with a letter and ends alphanumeric even for odd prefixes", () => {
    expect(cloudName("9x", "service/web", { max: 30 })).toMatch(/^[a-z]/);
    expect(cloudName("zn", "service/-web-", { max: 30 })).toMatch(/[a-z0-9]$/);
  });

  it("honours min length and the unique suffix", () => {
    expect(cloudName("a", "x/b", { max: 30, min: 6 }).length).toBeGreaterThanOrEqual(6);
    const u1 = cloudName("zn", "resource/uploads", { max: 63, unique: "env_1" });
    const u2 = cloudName("zn", "resource/uploads", { max: 63, unique: "env_2" });
    expect(u1).not.toBe(u2);
    expect(u1.length).toBeLessThanOrEqual(63);
  });
});

describe("gcpLabels", () => {
  it("lowercases and replaces disallowed characters, keys start with a letter, ≤ 63 chars", () => {
    const l = gcpLabels({ "zenith:workspace": "WS_1", "Zenith:Environment": "Env.One", "9lives": "x".repeat(100) });
    expect(l.zenith_workspace).toBe("ws_1");
    expect(l.zenith_environment).toBe("env_one");
    const keys = Object.keys(l);
    expect(keys.every((k) => /^[a-z][a-z0-9_-]{0,62}$/.test(k))).toBe(true);
    expect(Object.values(l).every((v) => /^[a-z0-9_-]{0,63}$/.test(v))).toBe(true);
    expect(l.z9lives).toBe("x".repeat(63));
  });

  it("is deterministic regardless of input key order and caps at 64 labels", () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 100; i++) tags[`k${String(i).padStart(3, "0")}`] = "v";
    const reversed = Object.fromEntries(Object.entries(tags).reverse());
    expect(JSON.stringify(gcpLabels(tags))).toBe(JSON.stringify(gcpLabels(reversed)));
    expect(Object.keys(gcpLabels(tags))).toHaveLength(64);
  });

  it("scopes labels to the node and matches them back", () => {
    const tags = { "zenith:environment": "env_1", "zenith:managed": "true" };
    const l = nodeLabels(tags, { address: "service/web" });
    expect(l.zenith_resource).toBe("service_web");
    expect(labelsMatch(l, l)).toBe(true);
    expect(labelsMatch({ ...l, zenith_resource: "service_api" }, l)).toBe(false);
    expect(labelsMatch({ ...l, zenith_environment: "env_2" }, l)).toBe(false);
    expect(labelsMatch(undefined, l)).toBe(false);
    expect(zenithTagged(l)).toBe(true);
    expect(zenithTagged({ team: "x" })).toBe(false);
  });

  it("an explicit zenith:resource tag wins over the node address", () => {
    expect(nodeLabels({ "zenith:environment": "e", "zenith:resource": "custom/x" }, { address: "service/web" }).zenith_resource).toBe("custom_x");
  });
});

describe("description tags (objects without labels)", () => {
  it("round-trips through tagDescription / parseTagDescription", () => {
    const tags = { "zenith:environment": "env_1" };
    const d = tagDescription(tags, { address: "network/main" }, "environment network");
    expect(parseTagDescription(d)).toEqual({ zenith_environment: "env_1", zenith_resource: "network_main" });
  });

  it("ignores descriptions Zenith did not write", () => {
    expect(parseTagDescription("my network zenith_environment=evil")).toEqual({});
    expect(parseTagDescription(undefined)).toEqual({});
  });
});

describe("networkTag", () => {
  it("is a stable, valid GCP network tag derived from the address", () => {
    const t = networkTag("service/web");
    expect(t).toBe(networkTag("service/web"));
    expect(t).toMatch(/^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/);
    expect(networkTag("service/web")).not.toBe(networkTag("service/worker"));
    expect(networkTag(`service/${"x".repeat(200)}`).length).toBeLessThanOrEqual(63);
  });
});

describe("hcl helpers", () => {
  it("escapes template introducers so a literal cannot evaluate", () => {
    expect(lit("${file(\"/etc/passwd\")}")).toBe('$${file("/etc/passwd")}');
    expect(lit("%{ if x }")).toBe("%%{ if x }");
    expect(lit("plain $ and { } are fine")).toBe("plain $ and { } are fine");
  });

  it("normalizes references to a template", () => {
    expect(asTemplate("a.b.c")).toBe("${a.b.c}");
    expect(asTemplate("${a.b.c}")).toBe("${a.b.c}");
    expect(inner("${a.b.c}")).toBe("a.b.c");
  });
});
