/** Bind a tenant-sealed kubeconfig's selected credential to its stored TLS target. */
import { load as yamlLoad } from "js-yaml";
import type { KubernetesConnectionConfig } from "@/lib/credentials/types";
import { validateServerUrl } from "./session";
import { K8sError } from "./types";

const MAX_BYTES = 256 * 1024;
function refuse(): never { throw new K8sError("session_invalid", "The vault kubeconfig target binding is unavailable or differs from the current connection."); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return refuse();
  return value as Record<string, unknown>;
}
function name(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return refuse();
  return value;
}
function entries(value: unknown, selectedName: string, field: string): Record<string, unknown> {
  if (!Array.isArray(value) || !value.length || value.length > 128) return refuse();
  const seen = new Set<string>();
  let selected: Record<string, unknown> | undefined;
  for (const raw of value) {
    const row = object(raw), current = name(row.name);
    if (seen.has(current) || !Object.hasOwn(row, field)) return refuse();
    seen.add(current);
    if (current === selectedName) selected = object(row[field]);
  }
  return selected ?? refuse();
}
function only(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) refuse();
}
function server(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 2048 || /[\s\u0000-\u001f\u007f?#]/.test(value)) return refuse();
  // Use the existing metadata/link-local and HTTPS policy, without its development exception.
  try { return validateServerUrl(value); } catch { return refuse(); }
}
function ca(value: unknown): Buffer {
  if (typeof value !== "string" || !value.length || value.length > MAX_BYTES) return refuse();
  const compact = value.replace(/[ \t\r\n]/g, "");
  if (!compact.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) return refuse();
  const bytes = Buffer.from(compact, "base64");
  if (!bytes.length || bytes.toString("base64") !== compact) return refuse();
  return bytes;
}

/** No target/proof is returned. The default broker checks its actual tenant vault value before credential use. */
export function assertVaultKubeconfigTarget(config: KubernetesConnectionConfig, text: string): void {
  try {
    if ((config.mode !== "kubeconfig_ref" && config.mode !== "scoped_guest") || typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BYTES) return refuse();
    const document = object(yamlLoad(text));
    if (document.apiVersion !== "v1" || document.kind !== "Config") return refuse();
    const context = entries(document.contexts, name(document["current-context"]), "context");
    only(context, ["cluster", "user", "namespace"]);
    const cluster = entries(document.clusters, name(context.cluster), "cluster");
    const user = entries(document.users, name(context.user), "user");
    // Other target/auth mechanisms cannot silently override this binding.
    only(cluster, ["server", "certificate-authority-data"]);
    only(user, ["token", "client-certificate-data", "client-key-data"]);
    const token = Object.hasOwn(user, "token"), cert = Object.hasOwn(user, "client-certificate-data"), key = Object.hasOwn(user, "client-key-data");
    if (token ? cert || key || typeof user.token !== "string" || !user.token.length
      : !cert || !key || typeof user["client-certificate-data"] !== "string" || !user["client-certificate-data"].length
        || typeof user["client-key-data"] !== "string" || !user["client-key-data"].length) return refuse();
    if (server(cluster.server) !== server(config.server) || !ca(cluster["certificate-authority-data"]).equals(ca(config.caData))) return refuse();
  } catch { return refuse(); }
}
