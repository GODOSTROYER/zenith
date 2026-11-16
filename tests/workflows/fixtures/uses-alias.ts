/**
 * Negative control for sandbox.test.ts: a workflow module that reaches a
 * shared file through the repo's `@/` path alias. Temporal's bundler does not
 * read tsconfig `paths`, so bundling this fails, which is why the real
 * definitions import relatively.
 */
import { TASK_QUEUE } from "@/lib/workflows/types";

export async function aliasWorkflow(): Promise<string> {
  return TASK_QUEUE;
}
