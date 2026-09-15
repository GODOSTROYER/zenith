/**
 * `POST /api/internal/tick/agent` — reconcile the agent control plane once.
 *
 * On Postgres, `Journal.recover()` cannot run at process construction the way
 * the single-writer file store does (a cold Vercel instance would poison every
 * other live instance's rows — `workerId` is per-process). So reconciliation is
 * a bounded, idempotent tick pass instead: running `running` rows whose lease
 * has expired move to `uncertain`; `prepared`/`approved` rows past their
 * expiry move to `expired`; link codes are swept; stale uploads are deleted.
 * See CONTROL-PLANE-ON-POSTGRES.md §6. Added as a fifth curl to
 * `.github/workflows/tick.yml`, on the same cron bearer as the other four.
 */
import { cronRoute } from "@/lib/server/cron";

// INTEGRATOR: remove this local stub once src/lib/agent-access/control/reconcile.ts
// (P2 owns; frozen contract F6, CONTROL-PLANE-ON-POSTGRES.md §6) lands, and import
// `agentTickPass` from "@/lib/agent-access/control/reconcile" instead — same name and
// signature, so the call site below does not change. Everything under
// src/lib/agent-access/control/ except http.ts is forbidden to this packet, so the
// real pass cannot be wired in from here; until it lands this route reconciles
// nothing and reports zero counts, which is honest (not a silent no-op disguised as
// success) and keeps the gate — bearer, 503-when-unset, 401-on-mismatch — provable
// independently of P2's landing.
interface AgentTickResult {
  reconciled: number;
  expired: number;
  links: number;
  uploads: number;
  ms: number;
}
async function agentTickPass(_budgetMs = 10_000): Promise<AgentTickResult> {
  return { reconciled: 0, expired: 0, links: 0, uploads: 0, ms: 0 };
}

const AGENT_TICK_BUDGET_MS = 10_000;

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = cronRoute("agent", async () => ({ ...(await agentTickPass(AGENT_TICK_BUDGET_MS)) }));
