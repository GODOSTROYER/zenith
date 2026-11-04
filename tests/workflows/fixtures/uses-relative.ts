/**
 * Positive control for sandbox.test.ts: the same import as uses-alias.ts, made
 * relative. It bundles.
 */
import { TASK_QUEUE } from "../../../src/lib/workflows/types";

export async function relativeWorkflow(): Promise<string> {
  return TASK_QUEUE;
}
