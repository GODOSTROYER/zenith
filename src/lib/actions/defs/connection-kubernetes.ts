/** Human onboarding only. Creation stores identifiers; verification reads the saved bound target. */
import { z } from "zod";
import { defineAction, actionPersistenceUnconfirmed, type ActionContext, type Role } from "@/lib/actions/core";
import { db, q, save, flushPendingAsync } from "@/lib/db/store";
import { id, type CloudConnection } from "@/lib/domain/types";
import type { KubernetesConnectionConfig } from "@/lib/credentials/types";
import { currentProductRoleResolver } from "@/lib/capabilities/current-product-roles";
import { findSecret } from "@/lib/capabilities/secret-guard";
import { digest } from "@/lib/controlplane/digest";
import { bridgeDeps } from "@/lib/bridge/deps";
import { validateServerUrl } from "@/lib/providers/kubernetes/session";
import { isDnsLabel } from "@/lib/providers/kubernetes/naming";
import { requireConnection } from "./_shared";

function validServer(value: string): boolean {
  try {
    const parsed = new URL(value);
    return !parsed.search && !parsed.hash && !/[\s\x00-\x1f\x7f]/.test(value) && !!validateServerUrl(value);
  } catch { return false; }
}
function validCa(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length > 0 && bytes.length <= 64 * 1024 && bytes.toString("base64") === value && !findSecret(bytes.toString("utf8"));
}
const Input = z.object({
  label: z.string().trim().min(1).max(120).refine(value => !findSecret(value), "Use a label without secret material.").optional(),
  server: z.string().min(1).max(2048).refine(validServer, "Use a trusted HTTPS API server without credentials, query or fragment."),
  caData: z.string().min(1).max(87384).refine(validCa, "Use bounded canonical base64 public CA data."),
  namespaces: z.array(z.string().refine(isDnsLabel, "Use a Kubernetes namespace name.")).min(1).max(32)
    .refine(values => new Set(values).size === values.length, "Use distinct namespaces."),
  credentialRef: z.string().min(7).max(200).regex(/^vault:[A-Za-z0-9_./:-]+$/, "Use an existing tenant vault reference."),
}).strict();
const SavedTarget = Input.omit({ label: true });
const Ref = z.object({ connectionId: z.string().min(1).max(200) }).strict();

async function human(ctx: ActionContext, minimum: "editor" | "admin"): Promise<boolean> {
  if (ctx.actor.type !== "user" || ctx.integration) return false;
  const owning = db().members.filter(member => member.workspaceId === ctx.workspaceId && member.id === ctx.actor.id);
  // Require a real member. Demo/empty-workspace fallback cannot originate this connection.
  if (owning.length !== 1 || !db().workspaces.some(workspace => workspace.id === ctx.workspaceId)) return false;
  const ranks: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
  if (!(owning[0].role in ranks) || ranks[owning[0].role] < ranks[minimum]) return false;
  try {
    const current = await currentProductRoleResolver().resolve({ kind: "user", id: ctx.actor.id, name: ctx.actor.name }, ctx.workspaceId);
    return current.role !== "none" && ranks[current.role] >= ranks[minimum];
  } catch { return false; }
}
const roleRefusal = () => ({ ok: false, summary: "Kubernetes connection refused.", error: "Current human workspace membership could not authorize this action." });
const permissions = ["Verification reads the default ServiceAccount in each saved namespace; it does not establish deployment, deletion, TLS or complete RBAC permissions."];

defineAction<z.infer<typeof Input>>({
  id: "connection.createKubernetes", title: "Connect Kubernetes", category: "connection", risk: "medium", requiredRole: "admin", mutates: true, input: Input,
  async plan(ctx) {
    return { summary: "Save a pending Kubernetes connection.", details: ["Only the saved HTTPS target, public CA, namespaces and tenant vault reference are recorded.",
      "The credential value is not read at creation. No cluster call or automatic verification runs.",
      "Run connection.verifyKubernetes after saving the full target-bound kubeconfig in the owning vault.", ...permissions],
      costDeltaUsd: 0, risk: "medium", warnings: [], requiresApproval: false,
      ...(!await human(ctx, "admin") ? { blocked: "A current human workspace admin is required." } : {}) };
  },
  async execute(ctx, input) {
    if (!await human(ctx, "admin")) return roleRefusal();
    const connectionId = id(), { label, ...identifiers } = input;
    const config: KubernetesConnectionConfig = { provider: "kubernetes", mode: "kubeconfig_ref", ...identifiers, server: validateServerUrl(input.server) };
    let nativeWritten = false;
    try {
      const { repos } = await import("@/lib/controlplane/db");
      const owner = await bridgeDeps().connectionSql();
      const created = await repos.connections.create(owner, { id: connectionId, legacyConnectionId: connectionId, workspaceId: ctx.workspaceId, createdBy: ctx.actor.id, config });
      nativeWritten = true;
      if (created.id !== connectionId || created.workspaceId !== ctx.workspaceId || created.legacyConnectionId !== connectionId
        || created.status !== "pending_verification" || digest(created.config) !== digest(config) || !await human(ctx, "admin")) throw new Error();
      if (db().connections.some(connection => connection.id === connectionId)) throw new Error();
      const connection: CloudConnection = { id: connectionId, workspaceId: ctx.workspaceId, provider: "kubernetes", label: label ?? "Kubernetes cluster",
        region: "in-cluster", status: "connecting", grantedPermissions: [...permissions], platformConnectionId: created.id, createdAt: new Date().toISOString() };
      db().connections.push(connection); save(); await flushPendingAsync();
      return { ok: true, summary: "Kubernetes connection saved pending namespace verification.", data: { connectionId, platformConnectionId: created.id, status: "connecting", platformStatus: created.status } };
    } catch {
      return actionPersistenceUnconfirmed({ ok: false, summary: "Kubernetes connection persistence is unconfirmed.",
        data: { connectionId, platformConnectionId: connectionId, persistence: nativeWritten ? "native_saved_product_unconfirmed" : "native_write_unconfirmed" } });
    }
  },
});

defineAction<z.infer<typeof Ref>>({
  id: "connection.verifyKubernetes", title: "Verify Kubernetes connection", category: "connection", risk: "low", requiredRole: "editor", mutates: true, input: Ref,
  async plan(ctx, input) {
    let available = false;
    try {
      const connection = requireConnection(ctx, input.connectionId);
      const originalProduct = digest(connection);
      if (connection.provider !== "kubernetes" || connection.platformConnectionId !== connection.id || !await human(ctx, "editor")) throw new Error();
      const { repos } = await import("@/lib/controlplane/db");
      const owner = await bridgeDeps().connectionSql();
      // Read only. Execution takes its own original capture before its provider probe.
      const captured = await repos.connections.captureVerification(owner, ctx.workspaceId, connection.platformConnectionId, ctx.actor.id);
      if (!captured || captured.connection.id !== connection.id || captured.connection.workspaceId !== ctx.workspaceId
        || captured.connection.legacyConnectionId !== connection.id) throw new Error();
      const { provider, mode, ...identifiers } = captured.connection.config;
      if (provider !== "kubernetes" || mode !== "kubeconfig_ref" || !SavedTarget.safeParse(identifiers).success
        || !await human(ctx, "editor") || q.connection(connection.id) !== connection || digest(connection) !== originalProduct) throw new Error();
      available = true;
    } catch { /* Missing, foreign and unavailable authority use the same disabled preview. */ }
    return { summary: "Read the saved Kubernetes namespace identity.", details: [...permissions], costDeltaUsd: 0, risk: "low", warnings: [], requiresApproval: false,
      ...(!available ? { blocked: "Kubernetes verification is unavailable for the current workspace connection." } : {}) };
  },
  async execute(ctx, input) {
    if (!await human(ctx, "editor")) return roleRefusal();
    const connection = requireConnection(ctx, input.connectionId);
    if (connection.provider !== "kubernetes" || connection.platformConnectionId !== connection.id) return { ok: false, summary: "Kubernetes verification refused.", error: "Create a matching platform-linked Kubernetes connection first." };
    const originalProduct = digest(connection);
    let nativeRecorded = false;
    try {
      const { repos } = await import("@/lib/controlplane/db");
      const { platformCredentialBroker } = await import("@/lib/platform/credentials");
      const owner = await bridgeDeps().connectionSql();
      const captured = await repos.connections.captureVerification(owner, ctx.workspaceId, connection.platformConnectionId, ctx.actor.id);
      if (!captured || captured.connection.legacyConnectionId !== connection.id || captured.connection.config.provider !== "kubernetes"
        || captured.connection.config.mode !== "kubeconfig_ref") throw new Error();
      const result = await platformCredentialBroker(owner).verifyConnection(captured.connection.id, { workspaceId: ctx.workspaceId });
      const current = await repos.connections.get(owner, ctx.workspaceId, captured.connection.id);
      if (!current || digest(current) !== digest(captured.connection) || !await human(ctx, "editor")
        || q.connection(connection.id) !== connection || digest(connection) !== originalProduct) throw new Error();
      const recorded = await repos.connections.recordCapturedVerification(owner, captured, { ok: result.ok,
        detail: result.ok ? "Saved Kubernetes namespace identity read succeeded; deployment permissions remain unverified." : "Saved Kubernetes namespace identity read failed." });
      if (!recorded) throw new Error();
      nativeRecorded = true;
      if (!await human(ctx, "editor") || q.connection(connection.id) !== connection || digest(connection) !== originalProduct) throw new Error();
      connection.status = result.ok ? "healthy" : "disconnected"; connection.lastCheckedAt = new Date().toISOString(); save(); await flushPendingAsync();
      return { ok: result.ok, summary: result.ok ? "Saved namespace identity verified; deployment permissions remain unverified." : "Kubernetes namespace verification failed.",
        data: { connectionId: connection.id, platformConnectionId: recorded.id, status: connection.status, platformStatus: recorded.status } };
    } catch {
      return actionPersistenceUnconfirmed({ ok: false, summary: "Kubernetes verification was not confirmed.",
        data: { connectionId: connection.id, platformConnectionId: connection.platformConnectionId, persistence: nativeRecorded ? "native_verification_saved_product_unconfirmed" : "verification_not_recorded" } });
    }
  },
});
