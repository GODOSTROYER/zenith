/** Pure selected-target models. Synthetic public CA bytes do not prove TLS or cluster identity. */
import { dump as yamlDump } from "js-yaml";
import { describe, expect, it } from "vitest";
import type { KubernetesConnectionConfig } from "@/lib/credentials/types";
import { assertVaultKubeconfigTarget } from "@/lib/providers/kubernetes/vault-target";

const CANARY = "sealed-credential-target-canary";
const CA = Buffer.from("synthetic-public-ca-bytes").toString("base64");
const CONFIG: KubernetesConnectionConfig = { provider: "kubernetes", mode: "kubeconfig_ref", server: "https://cluster.example.test", caData: CA,
  credentialRef: "vault:target/model/KUBECONFIG", namespaces: ["app"] };
function document() {
  return { apiVersion: "v1", kind: "Config", "current-context": "selected",
    clusters: [{ name: "cluster", cluster: { server: CONFIG.server, "certificate-authority-data": CA } as Record<string, unknown> }],
    contexts: [{ name: "selected", context: { cluster: "cluster", user: "operator" } as Record<string, unknown> }],
    users: [{ name: "operator", user: { token: CANARY } as Record<string, unknown> }] };
}
const text = (value: unknown) => yamlDump(value, { noRefs: true });
function refusal(config: KubernetesConnectionConfig, value: string) {
  let caught: unknown;
  try { assertVaultKubeconfigTarget(config, value); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ code: "session_invalid", message: "The vault kubeconfig target binding is unavailable or differs from the current connection." });
  expect(String(caught)).not.toContain(CANARY);
}

describe("vault kubeconfig selected target models", () => {
  it("accepts one selected context with the same normalized HTTPS server and exact decoded CA", () => {
    const d = document(); d.clusters[0].cluster.server = "https://CLUSTER.example.test:443/";
    expect(() => assertVaultKubeconfigTarget(CONFIG, text(d))).not.toThrow();
  });
  it("selects the named user rather than an earlier unused credential", () => {
    const d = document(); d.users.unshift({ name: "unused", user: { token: "unused-model-token" } });
    d.clusters.unshift({ name: "unused", cluster: { server: "https://unused.example.test", "certificate-authority-data": CA } });
    expect(() => assertVaultKubeconfigTarget(CONFIG, text(d))).not.toThrow();
  });
  it("accepts the selected embedded certificate pair without a bearer token", () => {
    const d = document(); d.users[0].user = { "client-certificate-data": "modeled-cert", "client-key-data": "modeled-key" };
    expect(() => assertVaultKubeconfigTarget(CONFIG, text(d))).not.toThrow();
  });
  it("compares decoded CA bytes rather than harmless base64 whitespace", () => {
    const d = document(); d.clusters[0].cluster["certificate-authority-data"] = ` ${CA.slice(0, 8)}\n${CA.slice(8)} `;
    expect(() => assertVaultKubeconfigTarget(CONFIG, text(d))).not.toThrow();
  });
  it.each(["missing current context", "unknown current context", "duplicate context", "duplicate cluster", "duplicate user", "missing selected cluster", "missing selected user", "wrong API version", "wrong kind", "missing CA", "different CA", "invalid CA encoding", "different server", "empty user", "mixed token and certificate", "partial certificate"])(
    "refuses %s with a fixed private diagnostic", mode => {
      const d = document();
      switch (mode) {
        case "missing current context": Reflect.deleteProperty(d, "current-context"); break;
        case "unknown current context": d["current-context"] = "absent"; break;
        case "duplicate context": d.contexts.push(d.contexts[0]); break;
        case "duplicate cluster": d.clusters.push(d.clusters[0]); break;
        case "duplicate user": d.users.push(d.users[0]); break;
        case "missing selected cluster": d.contexts[0].context.cluster = "absent"; break;
        case "missing selected user": d.contexts[0].context.user = "absent"; break;
        case "wrong API version": d.apiVersion = "v2"; break;
        case "wrong kind": d.kind = "Other"; break;
        case "missing CA": delete d.clusters[0].cluster["certificate-authority-data"]; break;
        case "different CA": d.clusters[0].cluster["certificate-authority-data"] = Buffer.from("foreign-public-ca").toString("base64"); break;
        case "invalid CA encoding": d.clusters[0].cluster["certificate-authority-data"] = "not-base64"; break;
        case "different server": d.clusters[0].cluster.server = "https://foreign.example.test"; break;
        case "empty user": d.users[0].user = {}; break;
        case "mixed token and certificate": d.users[0].user["client-certificate-data"] = "modeled-cert"; d.users[0].user["client-key-data"] = "modeled-key"; break;
        case "partial certificate": d.users[0].user = { "client-certificate-data": "modeled-cert" }; break;
        default: throw new Error("Unknown target fixture.");
      }
      refusal(CONFIG, text(d));
    });
  it.each(["insecure-skip-tls-verify", "certificate-authority", "proxy-url", "tls-server-name", "extensions"])("refuses selected cluster override %s", field => {
    const d = document(); d.clusters[0].cluster[field] = field === "insecure-skip-tls-verify" ? true : CANARY; refusal(CONFIG, text(d));
  });
  it.each(["exec", "auth-provider", "tokenFile", "client-certificate", "client-key", "username", "password", "as", "as-groups", "extensions"])("refuses selected user override %s", field => {
    const d = document(); d.users[0].user[field] = CANARY; refusal(CONFIG, text(d));
  });
  it.each(["https://user:password@cluster.example.test", "https://cluster.example.test?credential=private", "https://cluster.example.test#private", "http://127.0.0.1", "https://169.254.169.254", "https://metadata.google.internal", "https://[fe80::1]", "file:///private/config"])("refuses unsafe target %s in both stored and native configuration", target => {
    const d = document(); d.clusters[0].cluster.server = target;
    refusal(CONFIG, text(d)); refusal({ ...CONFIG, server: target }, text(document()));
  });
  it("refuses raw tokens, malformed YAML, oversized input and a native configuration without CA", () => {
    for (const value of [CANARY, "apiVersion: [", "x".repeat(256 * 1024 + 1)]) refusal(CONFIG, value);
    refusal({ ...CONFIG, caData: undefined }, text(document()));
  });
  it("refuses ambiguous selected context extensions and non-vault modes", () => {
    const d = document(); d.contexts[0].context.extensions = [{ name: CANARY }];
    refusal(CONFIG, text(d)); refusal({ ...CONFIG, mode: "oidc_web_identity" }, text(document()));
  });
});
