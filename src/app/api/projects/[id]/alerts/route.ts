/**
 * Alert rules and their open events for one project.
 *
 *   ?env=<id>   narrow to one environment (Observe always does)
 *
 * Returns `{ rules, channels, kinds, events, open, recent, simulated,
 * generatedBy, evaluatedAt, evaluationIntervalMs, delivery }`. `events` is open
 * alerts first, then the most recent closed ones — the banner reads the front
 * of that list, and each event carries its own `deliveries`. `channels` is the
 * workspace's delivery channels as metadata: no secrets, endpoint tokens
 * masked. There is no separate workspace route for them; they ride here.
 *
 * Reading evaluates: the conditions are recomputed from durable records before
 * the response is built, so the page never shows an answer up to a whole timer
 * tick out of date. The evaluation is idempotent (one open event per rule), so
 * a burst of readers produces one record, not one each.
 */
import {
  ALERT_KINDS,
  EVALUATION_INTERVAL_MS,
  emailProblem,
  evaluateProject,
  publicChannels,
  rulesOf,
  summaryFor,
} from "@/lib/alerts";
import { q } from "@/lib/db/store";
import { ApiError, requireWorkspace, route, scopedProject } from "@/lib/server/context";

export const dynamic = "force-dynamic";

/**
 * The delivery truth on the wire, so no client has to hardcode it. Written from
 * what this workspace actually has, not asserted: "no delivery" and "delivered
 * to two channels" are different sentences and the UI must not guess which.
 *
 * Not exported: a route module may only export the HTTP verbs and Next's own
 * config keys, and `tsc` fails the generated route type when it exports more.
 */
const deliveryNote = (enabled: number): string =>
  enabled === 0
    ? "In-product only. This workspace has no enabled delivery channels, so an alert is seen when somebody opens Orrery. Add one under Settings → Alerts."
    : `Shown in-product and delivered to ${enabled} enabled channel${enabled === 1 ? "" : "s"}. Each alert carries its own delivery results — a channel that failed says so rather than being left out.`;

export const GET = route<{ id: string }>(async (req, { id }) => {
  const workspace = requireWorkspace();
  const project = scopedProject(id);

  const environmentId = req.nextUrl.searchParams.get("env")?.trim() || undefined;
  if (environmentId) {
    const env = q.environment(environmentId);
    if (!env || env.projectId !== project.id)
      throw new ApiError(`Unknown environment "${environmentId}" for this project.`, 400, {
        fix: "Use an environment id from this project, or drop ?env= to see every environment.",
      });
  }

  evaluateProject(project.id);
  const { open, recent } = summaryFor(project.id, environmentId);
  /**
   * Workspace-wide, and deliberately on this payload: channels ride with the
   * alerts that use them, so Observe can name the channel behind a delivery
   * result and Settings → Alerts needs no route of its own. Secrets are
   * stripped and endpoint tokens masked by `publicChannels`.
   */
  const channels = publicChannels(workspace.id);

  return {
    rules: rulesOf(project.id, environmentId),
    channels,
    /**
     * The rule vocabulary — titles, what each kind watches, threshold ranges.
     * Sent rather than duplicated in the browser: the evaluator's own catalog is
     * the only definition, so UI copy cannot drift from what is evaluated.
     */
    kinds: ALERT_KINDS,
    /** open first, then the tail of history — one list the UI can render in order */
    events: [...open, ...recent],
    open,
    recent,
    /**
     * True: every condition Orrery can evaluate today reads generated health or
     * estimated cost. Individual events carry their own `simulated` flag — a
     * deployment failure on a real adapter is a real record.
     */
    simulated: true,
    generatedBy:
      "Orrery's alert evaluator, over the log simulator's health and the price table's estimates",
    evaluatedAt: new Date().toISOString(),
    evaluationIntervalMs: EVALUATION_INTERVAL_MS,
    delivery: deliveryNote(channels.filter((c) => c.enabled).length),
    /**
     * Why email delivery cannot work on this server, or null when it can. Sent
     * so Settings says it before an operator waits for a failed send to find
     * out. It names the environment variables, never their values.
     */
    emailProblem: emailProblem() ?? null,
  };
});
