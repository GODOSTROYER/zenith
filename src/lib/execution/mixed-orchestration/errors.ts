/**
 * Refusals of the mixed-graph output and failure orchestration (PROD-MIX-03, PROD-MIX-04).
 * Messages never carry a caller value: only fixed text. `detail` holds ids and component
 * names the caller already knows (child ids, reference ids), never output values.
 */
export type MixedOrchestrationErrorCode =
  | "invalid_input"
  | "dependency_cycle"
  | "unknown_child"
  | "contract_mismatch"
  | "scope_mismatch"
  | "output_provenance"
  | "secret_value"
  | "producer_not_succeeded"
  | "stale_digest"
  | "illegal_transition"
  | "run_terminal"
  | "ordering_blocked"
  | "teardown_refused"
  | "approval_invalid"
  | "ownership"
  | "preauthorization"
  | "conflict"
  | "unavailable";

const MESSAGES: Record<MixedOrchestrationErrorCode, string> = {
  invalid_input: "The mixed orchestration input is malformed.",
  dependency_cycle: "The child dependency graph contains a cycle; nothing was started.",
  unknown_child: "The child is not part of this parent plan.",
  contract_mismatch: "The output does not match a typed dependency contract of this plan.",
  scope_mismatch: "The output scope does not match the consumer's workspace, environment or connection.",
  output_provenance: "The output provenance does not match the producing child's reviewed plan or receipt.",
  secret_value: "Outputs carry vault references only; a secret value was refused.",
  producer_not_succeeded: "The producing child has not succeeded, so it has no output to consume.",
  stale_digest: "The reviewed digest no longer matches; review is required before this child can run.",
  illegal_transition: "That transition is not allowed from the child's current state.",
  run_terminal: "The run has ended; no further children start.",
  ordering_blocked: "An ordering rule blocks this step.",
  teardown_refused: "Teardown refused: it is not safe or not owned by this run.",
  approval_invalid: "A human destructive approval bound to this exact step is required.",
  ownership: "The resource is not owned by this run, so it cannot be torn down by it.",
  preauthorization: "No live, precise preauthorization covers this output.",
  conflict: "The run changed concurrently; reload and retry.",
  unavailable: "The orchestration store is unavailable.",
};

export class MixedOrchestrationError extends Error {
  constructor(readonly code: MixedOrchestrationErrorCode, readonly detail: readonly string[] = []) {
    super(MESSAGES[code]);
    this.name = "MixedOrchestrationError";
  }
}

export function refuse(code: MixedOrchestrationErrorCode, ...detail: string[]): never {
  throw new MixedOrchestrationError(code, detail);
}

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const sortedUnique = (items: Iterable<string>): string[] => [...new Set(items)].sort(cmp);
export const SHA = /^[a-f0-9]{64}$/;
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const VAULT_REF = /^vault:[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/;
