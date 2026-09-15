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
import { agentTickPass, AGENT_TICK_BUDGET_MS } from "@/lib/agent-access/control/reconcile";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = cronRoute("agent", async () => ({ ...(await agentTickPass(AGENT_TICK_BUDGET_MS)) }));
