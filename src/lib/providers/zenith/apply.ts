/**
 * Applying one managed environment: render, converge the managed databases,
 * then server-side apply through the Kubernetes provider's apply
 * (field manager `zenith`, `force: false`, ownership guard, namespace
 * allowlist — all of it the Kubernetes provider's, reused, not reimplemented).
 *
 *   1. databases  — `ensureManagedDatabases` (idempotent). Their connection
 *                   URIs go to the vault behind the `ConnectionSecretSink`;
 *                   the report carries only references.
 *   2. baseline   — Namespace, ServiceAccount, ResourceQuota, LimitRange,
 *                   NetworkPolicies. Applied FIRST and on their own so a
 *                   workload can never exist in a namespace without its
 *                   isolation, whatever order the apply layer sorts kinds in.
 *   3. TLS        — platform Certificate and per-environment Gateway, through
 *                   a separate gateway-namespace operator session.
 *   4. workloads  — Deployments, Services, Secrets, CronJobs, routes.
 *
 * It stops at the first phase that does not fully succeed and says which
 * (`blockedBy`); nothing is half-applied silently. Each apply phase is the
 * Kubernetes provider's own all-or-nothing preflight: an ownership conflict
 * refuses that whole phase.
 *
 * Dry run: no database is created or called; the baseline and workload phases
 * run as server-side dry-runs. A connection secret that does not exist yet
 * (the first deploy) resolves to a clearly fake placeholder so the dry run can
 * proceed; the placeholder is never persisted and never appears in a report.
 *
 * Honest limit: not transactional across phases; an abort after the baseline
 * leaves the baseline in place (it is idempotent and safe to keep).
 */
import type { ResourceNode } from "@/lib/resources/types";
import type { KubernetesToolkit, ToolkitApplyReport, ToolkitRenderBase } from "./k8s-port";
import { ensureManagedDatabases, type EnsureDatabaseOutcome } from "./database-lifecycle";
import { renderZenithEnvironment, type ZenithRenderResult } from "./render";
import { assertSessionMatches, type ZenithSession } from "./session";
import type { HostMapping } from "./routing";
import { ensureZenithTls, type ZenithTlsReport } from "./tls-lifecycle";
import type { TlsObjectClient } from "./tls-client";

export interface ZenithApplyInput extends Pick<ToolkitRenderBase, "workloadIdentity" | "resolveAttribute"> {
  session: ZenithSession;
  /** the workspace and environment of the OPERATION; the session must belong to exactly these */
  expect: { workspaceId: string; environmentId: string };
  toolkit: KubernetesToolkit;
  nodes: readonly ResourceNode[];
  builtImages?: Readonly<Record<string, string>>;
  /** resolves a `vault:` reference to its value for Secret objects; in memory, at apply time */
  resolveSecret: (ref: string) => Promise<string | null | undefined>;
  dryRun?: boolean;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Contract test port; production uses session.gatewayKubernetes. */
  tlsClient?: TlsObjectClient;
}

export type ZenithApplyBlocker = "database" | "baseline" | "tls" | "workloads";

export interface ZenithApplyReport {
  ok: boolean;
  dryRun: boolean;
  namespace: string;
  /** the phase that stopped the apply, when it did not fully succeed */
  blockedBy?: ZenithApplyBlocker;
  databases: EnsureDatabaseOutcome[];
  baseline?: ToolkitApplyReport;
  tls?: ZenithTlsReport;
  workloads?: ToolkitApplyReport;
  hostnames: HostMapping[];
  notes: string[];
}

/** A value no real credential can be, used only so a dry run can get past secret resolution. */
const DRY_RUN_PLACEHOLDER = "zenith-dry-run-placeholder";

export async function applyZenithEnvironment(input: ZenithApplyInput): Promise<ZenithApplyReport> {
  const { session, toolkit } = input;
  assertSessionMatches(session, input.expect);
  const dryRun = input.dryRun === true;
  const rendered: ZenithRenderResult = renderZenithEnvironment({
    tenant: session.tenant,
    substrate: session.substrate,
    nodes: input.nodes,
    toolkit,
    builtImages: input.builtImages,
    workloadIdentity: input.workloadIdentity,
    resolveAttribute: input.resolveAttribute,
  });

  const base = { dryRun, namespace: rendered.namespace, hostnames: rendered.hostnames, notes: rendered.notes };
  const databases = await ensureManagedDatabases(rendered.databases, session.databases, { dryRun, signal: input.signal });
  if (databases.some((d) => d.status === "failed")) {
    input.log?.("zenith apply blocked: a managed database could not be ensured");
    return { ...base, ok: false, blockedBy: "database", databases };
  }

  const dryRunRefs = new Set(rendered.databases.map((d) => d.connectionSecretRef));
  const resolveSecret = dryRun
    ? async (ref: string) => {
        const v = await input.resolveSecret(ref).catch(() => undefined);
        return v ?? (dryRunRefs.has(ref) ? DRY_RUN_PLACEHOLDER : v);
      }
    : input.resolveSecret;
  const opts = { dryRun, signal: input.signal, environmentId: session.tenant.environmentId, resolveSecret, log: input.log };

  const baseline = await toolkit.apply(rendered.baseline, session.kubernetes, opts);
  if (!baseline.ok) {
    input.log?.("zenith apply blocked: the tenancy baseline did not apply");
    return { ...base, ok: false, blockedBy: "baseline", databases, baseline };
  }
  const tls = await ensureZenithTls({ session, expect: input.expect, tlsClient: input.tlsClient, dryRun, signal: input.signal });
  if (!tls.ok) {
    input.log?.("zenith apply blocked: platform TLS objects did not apply");
    return { ...base, ok: false, blockedBy: "tls", databases, baseline, tls };
  }
  const workloads = await toolkit.apply(rendered.workloads, session.kubernetes, opts);
  if (!workloads.ok) return { ...base, ok: false, blockedBy: "workloads", databases, baseline, tls, workloads };
  return { ...base, ok: true, databases, baseline, tls, workloads };
}
