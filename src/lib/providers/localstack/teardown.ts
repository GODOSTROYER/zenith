/**
 * Removing a bucket or a queue from the system deletes it in LocalStack, in
 * the same deployment, or the deployment fails. These are the steps that make
 * that true. Split out of the single-file adapter; the code is unchanged.
 */
import { LOCALSTACK_ENDPOINT, bucketName, queueName } from "./clients";
import type { Environment, Manifest } from "@/lib/domain/types";
import type { ProviderPlanStep } from "@/lib/providers/types";


/* -------------------------------- teardown --------------------------------- */

/**
 * The plan/execute contract for a teardown step, in one place because it is the
 * one thing here that crosses a process boundary.
 *
 * `executeStep` resolves its target inside `revision.manifest` — the NEXT
 * manifest, which by definition no longer holds the node being torn down. Of a
 * `ProviderPlanStep` the engine copies only `phase`, `title`, `targetId` and
 * `detail` onto the step it later hands back, so the provider-native `detail`
 * line IS the instruction: it carries the concrete LocalStack name to delete.
 *
 * Keep both sides in sync. A step that reads as a teardown but no longer parses
 * must fail loudly rather than no-op — silently doing nothing is precisely the
 * bug this section exists to remove.
 */
export const DELETE_BUCKET = "s3:DeleteBucket";
export const DELETE_QUEUE = "sqs:DeleteQueue";
export const NO_CALL = "No LocalStack call —";
export const TEARDOWN_CALL = new RegExp(`^(${DELETE_BUCKET}|${DELETE_QUEUE}) (\\S+)`);

export type TeardownIntent =
  | { kind: "bucket" | "queue"; name: string }
  | { kind: "simulated"; name: null };

export function teardownIntent(detail: string | undefined): TeardownIntent | null {
  if (!detail) return null;
  const call = TEARDOWN_CALL.exec(detail);
  if (call) return { kind: call[1] === DELETE_BUCKET ? "bucket" : "queue", name: call[2] };
  return detail.startsWith(NO_CALL) ? { kind: "simulated", name: null } : null;
}

/** Titles this file gives teardown steps, so a lost `detail` is detectable. */
export const looksLikeTeardown = (title: string) => title.startsWith("Delete ") || title.startsWith("Forget ");

/**
 * Nothing was ever created for this kind, so nothing is deleted — and the step
 * says that outright instead of miming a teardown it did not perform.
 */
export const forgetStep = (targetId: string, what: string): ProviderPlanStep => ({
  phase: "release",
  title: `Forget ${what} — nothing was created in LocalStack to delete`,
  targetId,
  estMs: 600,
  detail: `${NO_CALL} ${what} ran as a labeled local simulation, so there is nothing at ${LOCALSTACK_ENDPOINT} to delete. The exported Terraform destroys the real thing on AWS.`,
});

/**
 * Steps for everything the PREVIOUS revision managed and the next one drops.
 *
 * Planning used to iterate only the next manifest, which meant a bucket or
 * queue you deleted from your system stayed live at the endpoint while the
 * deployment reported success: the revision said "gone", `observe` said
 * "there", and drift flagged it as extra seconds later. A deployment must never
 * claim it converged to a revision it contradicts — so removal is planned, and
 * a removal that cannot be carried out fails the deployment instead.
 *
 * Ordering is the reverse of creation — routes, then services, then the
 * resources they were using — so nothing is deleted while something still
 * points at it, and the whole block sits AFTER every create/update step for the
 * revision and BEFORE `verify`. (`DeploymentStep.phase` has no "teardown"
 * member and that type is not this file's to change; `release` is the last
 * mutating phase, so the timeline's phase grouping renders these in the order
 * they actually run.)
 */
export function teardownSteps(env: Environment, next: Manifest, previous?: Manifest): ProviderPlanStep[] {
  if (!previous) return [];
  const kept = new Set([
    ...next.services.map((s) => s.id),
    ...next.resources.map((r) => r.id),
    ...next.routes.map((r) => r.id),
  ]);
  const steps: ProviderPlanStep[] = [];

  for (const route of previous.routes)
    if (!kept.has(route.id)) steps.push(forgetStep(route.id, `routing for ${route.host}`));

  for (const s of previous.services)
    if (s.ownership === "managed" && !kept.has(s.id))
      steps.push(forgetStep(s.id, `${s.kind === "cron" ? "schedule" : "rollout"} of ${s.name}`));

  for (const r of previous.resources) {
    if (r.ownership !== "managed" || kept.has(r.id)) continue;
    if (r.kind === "object_store") {
      const name = bucketName(r.name, env);
      steps.push({
        phase: "release",
        title: `Delete S3 bucket "${name}" from LocalStack — "${r.name}" is not in this revision`,
        targetId: r.id,
        estMs: 2500,
        detail: `${DELETE_BUCKET} ${name} via ${LOCALSTACK_ENDPOINT} — objects are emptied first only when this environment allows stateful deletion, otherwise the step refuses`,
      });
    } else if (r.kind === "queue") {
      const name = queueName(r.name, env);
      steps.push({
        phase: "release",
        title: `Delete SQS queue "${name}" from LocalStack — "${r.name}" is not in this revision`,
        targetId: r.id,
        estMs: 2000,
        detail: `${DELETE_QUEUE} ${name} via ${LOCALSTACK_ENDPOINT} — refused while the queue still holds messages, unless this environment allows stateful deletion`,
      });
    } else {
      steps.push(forgetStep(r.id, `simulated ${r.kind} "${r.name}"`));
    }
  }

  return steps;
}
