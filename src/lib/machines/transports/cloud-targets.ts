/** Strict observed identities only: no URL following, inferred zone or cross-account target. */
import { parseArmId } from "@/lib/providers/azure/arm";

export function parseAzureVmTargetId(id: string): { subscriptionId: string; path: string } | undefined {
  // Restrict segments before handing the path to ARM; percent escapes and query strings are refused.
  if (!/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9_().-]{1,90}\/providers\/Microsoft\.Compute\/virtualMachines\/[A-Za-z0-9_().-]{1,64}$/i.test(id)) return;
  const p = parseArmId(id);
  if (!p || p.segments.length !== 1) return;
  return { subscriptionId: p.subscriptionId, path: id };
}

export function parseGcpInstanceTargetId(id: string): { project: string; zone: string; instance: string; path: string } | undefined {
  // Compute observations may use a selfLink or the project-relative resource name.
  const path = id.replace(/^https:\/\/(?:www|compute)\.googleapis\.com\/compute\/v1\//, "");
  const m = /^projects\/([a-z][a-z0-9-]{4,61}[a-z0-9]|[1-9][0-9]{0,19})\/zones\/([a-z][a-z0-9-]{0,62})\/instances\/([a-z][a-z0-9-]{0,61}[a-z0-9]|[a-z]|[1-9][0-9]{0,19})$/.exec(path);
  if (!m) return;
  return { project: m[1], zone: m[2], instance: m[3], path };
}
