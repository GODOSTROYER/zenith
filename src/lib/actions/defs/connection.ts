/**
 * Cloud connections. Availability drives every word here: a "planned"
 * provider cannot be connected at all, and a "preview" one says what it can
 * and cannot do before you pick it.
 */
import { z } from "zod";
import { defineAction } from "@/lib/actions/core";
import { db, q, save } from "@/lib/db/store";
import { id, ProviderId, type CloudConnection } from "@/lib/domain/types";
import { getProvider, providerRegistry, type ProviderAdapter, type PreflightReport } from "@/lib/providers/types";
import { getEngine } from "./_engine";

/** Provider adapters register themselves with the engine; make sure that ran. */
async function adapterFor(provider: ProviderId): Promise<ProviderAdapter> {
  if (!providerRegistry().has(provider)) await getEngine();
  return getProvider(provider);
}

function statusFrom(report: PreflightReport): CloudConnection["status"] {
  if (report.ok) return "healthy";
  return report.checks.some((c) => c.status === "fail") ? "disconnected" : "degraded";
}

function checkLines(report: PreflightReport): string[] {
  return report.checks.map(
    (c) => `${c.status === "pass" ? "ok" : c.status}: ${c.label}${c.detail ? ` — ${c.detail}` : ""}${c.fix ? ` Fix: ${c.fix}` : ""}`
  );
}

/* ----------------------------- connection.create --------------------------- */

const CreateConn = z.object({
  provider: ProviderId,
  label: z.string().optional(),
  region: z.string().optional(),
});
type CreateConn = z.infer<typeof CreateConn>;

function resolveRegion(adapter: ProviderAdapter, region?: string): string {
  if (!region) return adapter.regions[0]?.id ?? "default";
  if (adapter.regions.length && !adapter.regions.some((r) => r.id === region))
    throw new Error(
      `${adapter.displayName} has no region "${region}". Pick one of: ${adapter.regions.map((r) => r.id).join(", ")}.`
    );
  return region;
}

defineAction<CreateConn>({
  id: "connection.create",
  title: "Connect a cloud",
  category: "connection",
  risk: "medium",
  requiredRole: "admin",
  mutates: true,
  input: CreateConn,
  async plan(_ctx, input) {
    const adapter = await adapterFor(input.provider);
    const access = adapter.accessExplanation();
    const region = resolveRegion(adapter, input.region);
    const planned = adapter.availability === "planned";
    return {
      summary: planned
        ? `${adapter.displayName} cannot be connected yet.`
        : `Connect ${adapter.displayName} in ${region}.`,
      details: [
        `${adapter.displayName} is ${adapter.availability}: ${adapter.tagline}`,
        access.summary,
        ...access.permissions.map((p) => `Grants: ${p}`),
        adapter.availability === "preview"
          ? "Preview means Orrery plans and exports for this provider, but does not apply changes to it."
          : "",
      ].filter(Boolean),
      costDeltaUsd: 0,
      risk: planned ? "low" : "medium",
      warnings: planned
        ? [`${adapter.displayName} is planned, not implemented. Use the sandbox to try Orrery end to end, or connect a provider marked available.`]
        : [],
      requiresApproval: false,
    };
  },
  async execute(ctx, input) {
    const adapter = await adapterFor(input.provider);
    if (adapter.availability === "planned")
      return {
        ok: false,
        summary: `${adapter.displayName} is not available yet.`,
        error: `${adapter.displayName} is planned, not implemented — connecting it would do nothing. Deploy to the sandbox instead, or export Terraform and run it yourself.`,
      };

    const region = resolveRegion(adapter, input.region);
    const conn: CloudConnection = {
      id: id(),
      workspaceId: ctx.workspaceId,
      provider: adapter.id,
      label: input.label?.trim() || `${adapter.displayName} ${region}`,
      region,
      status: "connecting",
      grantedPermissions: adapter.accessExplanation().permissions,
      createdAt: new Date().toISOString(),
    };
    db().connections.push(conn);

    const report = await adapter.preflight(conn);
    conn.status = statusFrom(report);
    conn.lastCheckedAt = new Date().toISOString();
    save();

    if (!report.ok) {
      const firstProblem = report.checks.find((c) => c.status !== "pass");
      return {
        ok: false,
        summary: `${conn.label} was saved but is not usable yet (${conn.status}).`,
        error:
          firstProblem?.fix ??
          `${firstProblem?.label ?? "A preflight check"} did not pass. Fix it and run connection.check, or remove the connection with connection.disconnect.`,
        data: { connectionId: conn.id, status: conn.status, checks: report.checks },
      };
    }
    // Count what actually passed. `checks.length` counted warnings as passes,
    // so a connection with three caveats reported "3 checks passed".
    const passed = report.checks.filter((c) => c.status === "pass").length;
    const warned = report.checks.filter((c) => c.status === "warn").length;
    return {
      ok: true,
      summary:
        `Connected ${conn.label} (${adapter.availability}). ${passed} of ${report.checks.length} preflight check(s) passed` +
        (warned ? `, ${warned} with a caveat.` : "."),
      data: { connectionId: conn.id, status: conn.status, checks: report.checks, permissions: report.permissions },
    };
  },
});

/* ------------------------------ connection.check --------------------------- */

const ConnRef = z.object({ connectionId: z.string().min(1) });
type ConnRef = z.infer<typeof ConnRef>;

function requireConnection(connectionId: string): CloudConnection {
  const c = q.connection(connectionId);
  if (!c)
    throw new Error(`Connection "${connectionId}" was not found. Pick one in Settings → Connections.`);
  return c;
}

defineAction<ConnRef>({
  id: "connection.check",
  title: "Check connection",
  category: "connection",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: ConnRef,
  plan(_ctx, input) {
    const conn = requireConnection(input.connectionId);
    return {
      summary: `Re-run preflight for ${conn.label}.`,
      details: [
        `Currently ${conn.status}${conn.lastCheckedAt ? `, last checked ${conn.lastCheckedAt}` : ", never checked"}.`,
        "Read-only: preflight inspects access and quotas, and changes nothing in your cloud.",
      ],
      costDeltaUsd: 0,
      risk: "low",
      warnings: [],
      requiresApproval: false,
    };
  },
  async execute(_ctx, input) {
    const conn = requireConnection(input.connectionId);
    const adapter = await adapterFor(conn.provider);
    const report = await adapter.preflight(conn);
    conn.status = statusFrom(report);
    conn.lastCheckedAt = new Date().toISOString();
    conn.grantedPermissions = report.permissions;
    save();
    const failed = report.checks.filter((c) => c.status !== "pass");
    const passed = report.checks.length - failed.length;
    return {
      ok: report.ok,
      summary: report.ok
        ? `${conn.label} is healthy — ${passed} of ${report.checks.length} check(s) passed` +
          (failed.length ? `, ${failed.length} with a caveat.` : ".")
        : `${conn.label} is ${conn.status}: ${failed.length} check(s) need attention.`,
      error: report.ok ? undefined : failed.map((c) => `${c.label}: ${c.fix ?? c.detail ?? "no detail"}`).join(" "),
      data: { connectionId: conn.id, status: conn.status, checks: report.checks, lines: checkLines(report) },
    };
  },
});

/* ---------------------------- connection.disconnect ------------------------ */

function usersOf(connectionId: string): { envName: string; projectName: string }[] {
  return db()
    .environments.filter((e) => e.connectionId === connectionId)
    .map((e) => ({
      envName: e.name,
      projectName: q.project(e.projectId)?.name ?? e.projectId,
    }));
}

/** The one refusal sentence, so plan.blocked and the execute error are the same. */
function stillInUse(conn: CloudConnection, users: ReturnType<typeof usersOf>): string {
  return `${users.map((u) => `${u.projectName}/${u.envName}`).join(", ")} still deploy through ${conn.label}. Point each one at another connection (Settings → Environments → Change), or delete them, then disconnect.`;
}

defineAction<ConnRef>({
  id: "connection.disconnect",
  title: "Disconnect",
  category: "connection",
  risk: "medium",
  requiredRole: "admin",
  mutates: true,
  input: ConnRef,
  plan(_ctx, input) {
    const conn = requireConnection(input.connectionId);
    const users = usersOf(conn.id);
    const blocked = users.length > 0;
    return {
      summary: blocked
        ? `${conn.label} cannot be disconnected — ${users.length} environment(s) still use it.`
        : `Disconnect ${conn.label}.`,
      details: blocked
        ? users.map((u) => `${u.projectName} → ${u.envName} deploys through this connection.`)
        : [
            "Removes the connection from this workspace.",
            "Nothing in your cloud is deleted or changed — Orrery only forgets how to reach it.",
          ],
      costDeltaUsd: 0,
      risk: blocked ? "low" : "medium",
      warnings: [],
      requiresApproval: false,
      // Same sentence execute() would return, so the dialog disables Confirm
      // instead of offering a button that fails one click later.
      blocked: blocked ? stillInUse(conn, users) : undefined,
    };
  },
  execute(_ctx, input) {
    const conn = requireConnection(input.connectionId);
    const users = usersOf(conn.id);
    if (users.length)
      return {
        ok: false,
        summary: `${conn.label} is still in use.`,
        error: stillInUse(conn, users),
      };
    db().connections = db().connections.filter((c) => c.id !== conn.id);
    save();
    return {
      ok: true,
      summary: `Disconnected ${conn.label}. Nothing in your cloud was changed.`,
      data: { connectionId: conn.id },
    };
  },
});
