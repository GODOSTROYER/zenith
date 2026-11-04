/**
 * Negative control for sandbox.test.ts: a workflow module importing a Node
 * built-in. The workflow sandbox has no `fs`; the bundler must refuse it.
 */
import { readFileSync } from "node:fs";

export async function nodeWorkflow(): Promise<string> {
  return readFileSync("/etc/hostname", "utf8");
}
