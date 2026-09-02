/**
 * Alert rules and their open events for one project.
 *
 *   ?env=<id>   narrow to one environment (Observe always does)
 *
 * Returns `{ rules, events, open, recent, simulated, generatedBy, evaluatedAt,
 * evaluationIntervalMs, delivery }`. `events` is open alerts first, then the
 * most recent closed ones — the banner reads the front of that list.
 *
 * Reading evaluates: the conditions are recomputed from durable records before
 * the response is built, so the page never shows an answer up to a whole timer
 * tick out of date. The evaluation is idempotent (one open event per rule), so
 * a burst of readers produces one record, not one each.
 */
import {
  ALERT_KINDS,
  EVALUATION_INTERVAL_MS,
  evaluateProject,
  rulesOf,
  summaryFor,
} from "@/lib/alerts";
import { inWorkspace, q } from "@/lib/db/store";
import { ApiError, notFound, requireWorkspace, route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

/**
 * The delivery truth on the wire, so no client has to hardcode it.
 *
 * Not exported: a route module may only export the HTTP verbs and Next's own
 * config keys, and `tsc` fails the generated route type when it exports more.
 */
const DELIVERY_NOTE =
  "In-product only. Orrery has no email, Slack or webhook delivery: an alert is seen when somebody opens Orrery.";

export const GET = route<{ id: string }>(async (req, { id }) => {
  const project = q.project(id);
  // Scoped by workspace: an id alone is not a read grant.
  if (!project || !inWorkspace(requireWorkspace().id, project.id))
    throw notFound(`Project "${id}"`, "Check the URL, or pick a project from the overview.");

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

  return {
    rules: rulesOf(project.id, environmentId),
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
    delivery: DELIVERY_NOTE,
  };
});
