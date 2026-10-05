/** PROD-UX-03: manifest schema and provenance verification (real Ed25519, keys generated at runtime). */
import { describe, expect, it } from "vitest";
import { parseManifest, trustedPublishersFromEnv, verifyProvenance } from "@/lib/plugins/manifest";
import { PluginError } from "@/lib/plugins/errors";
import { baseManifest, KEY_ID, makePublisher, signManifest } from "./support";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof PluginError ? error.code : `other:${String(error)}`;
  }
  return undefined;
};

describe("plugin manifest schema", () => {
  const { privateKey } = makePublisher();
  const signed = (over = {}) => signManifest(baseManifest(over), privateKey);

  it("accepts a well formed manifest and derives a stable digest", () => {
    const a = parseManifest(signed());
    const b = parseManifest(signed());
    expect(a.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.manifestDigest).toBe(b.manifestDigest);
    expect(a.artifactDigest).toBe("a".repeat(64));
  });

  it("changes the digest when any capability changes", () => {
    const a = parseManifest(signed());
    const b = parseManifest(signed({ capabilities: { tools: ["zenith_get_topology"], scopes: ["read"] } }));
    expect(a.manifestDigest).not.toBe(b.manifestDigest);
  });

  it.each([
    ["unknown tool", { capabilities: { tools: ["zenith_run_shell"], scopes: ["read"] } }],
    ["tool whose scope is not requested", { capabilities: { tools: ["zenith_query_logs"], scopes: ["read"] } }],
    ["no read scope", { capabilities: { tools: ["zenith_get_topology"], scopes: ["logs"] } }],
    ["duplicate tools", { capabilities: { tools: ["zenith_get_topology", "zenith_get_topology"], scopes: ["read"] } }],
    ["credential access request", { isolation: { credentials: "vault", store: "none", network: "mcp-only", tokenPassthrough: "forbidden" } }],
    ["direct store access request", { isolation: { credentials: "none", store: "read", network: "mcp-only", tokenPassthrough: "forbidden" } }],
    ["token passthrough request", { isolation: { credentials: "none", store: "none", network: "mcp-only", tokenPassthrough: "allowed" } }],
    ["unrestricted network request", { isolation: { credentials: "none", store: "none", network: "any", tokenPassthrough: "forbidden" } }],
    ["id outside the publisher namespace", { id: "other/topology-viewer" }],
    ["bad version", { version: "latest" }],
    ["bad artifact digest", { artifact: { digest: "md5:abc" } }],
    ["extra undeclared member", { permissions: ["*"] }],
  ])("refuses %s", (_name, over) => {
    expect(code(() => parseManifest(signManifest({ ...baseManifest(), ...over } as never, privateKey)))).toBe("plugin_manifest_invalid");
  });

  it("refuses a manifest with no signature member", () => {
    const { signature: _drop, ...unsigned } = signed();
    void _drop;
    expect(code(() => parseManifest(unsigned))).toBe("plugin_manifest_invalid");
  });
});

describe("plugin provenance", () => {
  it("verifies a manifest signed by a trusted publisher key", () => {
    const { privateKey, publishers } = makePublisher();
    const parsed = parseManifest(signManifest(baseManifest(), privateKey));
    expect(verifyProvenance(parsed, publishers, new Date("2026-10-05T00:00:00Z"))).toMatchObject({ publisherId: "acme", keyId: KEY_ID, alg: "ed25519", manifestDigest: parsed.manifestDigest, artifactDigest: "a".repeat(64), verifiedAt: "2026-10-05T00:00:00.000Z" });
  });

  it("refuses every registration when no publisher is trusted", () => {
    const { privateKey } = makePublisher();
    const parsed = parseManifest(signManifest(baseManifest(), privateKey));
    expect(code(() => verifyProvenance(parsed, trustedPublishersFromEnv({})))).toBe("plugin_provenance_unverified");
  });

  it("refuses a manifest edited after signing (capability widened, artifact swapped, version bumped)", () => {
    const { privateKey, publishers } = makePublisher();
    const signed = signManifest(baseManifest(), privateKey);
    const widened = { ...signed, capabilities: { tools: [...signed.capabilities.tools, "zenith_scale_service"], scopes: [...signed.capabilities.scopes, "write"] } };
    const swapped = { ...signed, artifact: { digest: `sha256:${"b".repeat(64)}` } };
    const bumped = { ...signed, version: "1.0.1" };
    for (const tampered of [widened, swapped, bumped]) {
      expect(code(() => verifyProvenance(parseManifest(tampered), publishers))).toBe("plugin_provenance_unverified");
    }
  });

  it("refuses a signature from a key the publisher does not hold, or a different publisher's key", () => {
    const trusted = makePublisher();
    const attacker = makePublisher();
    const forged = parseManifest(signManifest(baseManifest(), attacker.privateKey));
    expect(code(() => verifyProvenance(forged, trusted.publishers))).toBe("plugin_provenance_unverified");
    const unknownKeyId = parseManifest(signManifest(baseManifest(), trusted.privateKey, "rotated-away"));
    expect(code(() => verifyProvenance(unknownKeyId, trusted.publishers))).toBe("plugin_provenance_unverified");
    const otherPublisher = makePublisher("someone-else", "k1");
    const claimsAcme = parseManifest(signManifest(baseManifest(), otherPublisher.privateKey));
    expect(code(() => verifyProvenance(claimsAcme, otherPublisher.publishers))).toBe("plugin_provenance_unverified");
  });

  it("rejects malformed trusted-publisher configuration instead of ignoring it", () => {
    expect(code(() => trustedPublishersFromEnv({ ZENITH_PLUGIN_TRUSTED_PUBLISHERS: "{not json" }))).toBe("plugin_unavailable");
    expect(code(() => trustedPublishersFromEnv({ ZENITH_PLUGIN_TRUSTED_PUBLISHERS: JSON.stringify({ acme: [{ keyId: "k", publicKey: "AAAA".repeat(12) }] }) }))).toBe("plugin_unavailable");
  });
});
