/**
 * Evidence verification for a live mixed-cloud acceptance run (PROD-MIX-01 / 02).
 *
 * The live run itself is operator-driven (approvals need a person's browser): plan,
 * approve the parent, bind each child, start, then point this verifier at the plan.
 * It reads `GET /api/platform/v1/mixed/plans/:id` and checks the stored evidence is
 * internally consistent and complete. It never calls a cloud, and it can only say
 * "evidence is consistent"; it does not turn missing evidence into a pass.
 *
 * Credentials: the bearer token is read from a FILE the operator names, never from the
 * command line or the environment value, and is never printed.
 */
import { readFileSync } from "node:fs";

export interface LivePlanChild {
  partitionId: string;
  ordinal: number;
  childEnvironmentId: string;
  dependsOn: string[];
  subplanDigest: string;
  semanticsDigest: string;
  partition: { provider: string; accountId: string; region: string; backendKind: string; backendDigest: string; connectionId: string; connectionIdentityDigest: string };
  nodes: { stableAddress: string; address: string }[];
  state: string;
  childOperationId: string | null;
  executableSemanticsDigest: string | null;
  receipt: { outcome: string; childOperationId: string; ordinal: number; executableSemanticsDigest?: string; receiptDigest: string } | null;
}

export interface LivePlanView {
  parentPlanId: string;
  status: string;
  parentOperationId: string | null;
  childSetDigest: string;
  executionOrder: string[];
  teardownOrder: string[];
  children: LivePlanChild[];
}

export interface EvidenceVerdict {
  ok: boolean;
  problems: string[];
  /** what a clean verdict does NOT establish */
  limits: string[];
}

const HEX = /^[a-f0-9]{64}$/;
const LIMITS = [
  "Stored platform evidence only; it does not read any cloud account.",
  "A receipt is a durable statement by the platform, not provider certainty about quiescence.",
];

export function verifyMixedEvidence(raw: unknown): EvidenceVerdict {
  const problems: string[] = [];
  const view = raw as LivePlanView | null;
  if (!view || typeof view !== "object" || !Array.isArray(view.children)) return { ok: false, problems: ["The plan view is not readable."], limits: LIMITS };
  if (view.status !== "succeeded") problems.push(`The plan status is ${String(view.status)}, not succeeded.`);
  if (!view.parentOperationId) problems.push("The plan has no parent operation, so no person's approval is bound to it.");
  if (!HEX.test(String(view.childSetDigest))) problems.push("The child set digest is missing or malformed.");
  const ordered = [...view.children].sort((a, b) => a.ordinal - b.ordinal);
  if (ordered.length < 2) problems.push("A mixed run needs at least two children.");
  if (ordered.map((c) => c.partitionId).join("|") !== view.executionOrder.join("|")) problems.push("The children do not follow the stored execution order.");
  if ([...view.executionOrder].reverse().join("|") !== view.teardownOrder.join("|")) problems.push("The teardown order is not the reverse of the execution order.");
  const providers = new Set(ordered.map((c) => c.partition.provider));
  if (providers.size < 2) problems.push("A mixed run needs children on at least two providers.");
  if (new Set(ordered.map((c) => c.partition.backendDigest)).size !== ordered.length) problems.push("Two children share a state backend.");
  if (new Set(ordered.map((c) => c.partition.connectionIdentityDigest)).size !== ordered.length) problems.push("Two children share a connection identity.");
  const seen = new Set<string>();
  for (const child of ordered) {
    const label = `Child ${child.ordinal + 1}`;
    if (child.state !== "succeeded") problems.push(`${label} is ${child.state}, not succeeded.`);
    if (!child.childOperationId) problems.push(`${label} has no operation.`);
    const receipt = child.receipt;
    if (!receipt) { problems.push(`${label} has no durable receipt.`); continue; }
    if (receipt.outcome !== "succeeded") problems.push(`${label}'s receipt says ${receipt.outcome}.`);
    if (receipt.childOperationId !== child.childOperationId) problems.push(`${label}'s receipt names a different operation.`);
    if (receipt.ordinal !== child.ordinal) problems.push(`${label}'s receipt has the wrong ordinal.`);
    if (!HEX.test(String(receipt.receiptDigest))) problems.push(`${label}'s receipt digest is malformed.`);
    if (!HEX.test(String(child.executableSemanticsDigest))) problems.push(`${label} has no reviewed executable semantics digest.`);
    else if (receipt.executableSemanticsDigest !== child.executableSemanticsDigest) problems.push(`${label}'s receipt and row disagree on the reviewed semantics.`);
    for (const dependency of child.dependsOn) {
      const dep = ordered.find((c) => c.partitionId === dependency);
      if (!dep || dep.ordinal >= child.ordinal) problems.push(`${label} depends on a child that did not run before it.`);
    }
    for (const node of child.nodes) {
      if (seen.has(node.stableAddress)) problems.push(`The stable address ${node.stableAddress} appears twice.`);
      seen.add(node.stableAddress);
      if (!node.stableAddress.endsWith(`::${node.address}`)) problems.push(`The stable address of ${node.address} does not name it.`);
    }
  }
  return { ok: problems.length === 0, problems, limits: LIMITS };
}

export async function fetchPlanView(input: { apiUrl: string; workspaceId: string; planId: string; tokenFile: string; fetchImpl?: typeof fetch }): Promise<unknown> {
  const origin = new URL(input.apiUrl);
  if (origin.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) throw new Error("The control plane URL must be https (or a local development host).");
  const token = readFileSync(input.tokenFile, "utf8").trim();
  if (!token) throw new Error("The token file is empty.");
  const response = await (input.fetchImpl ?? fetch)(new URL(`/api/platform/v1/mixed/plans/${encodeURIComponent(input.planId)}`, origin), {
    headers: { authorization: `Bearer ${token}`, "x-zenith-workspace": input.workspaceId },
  });
  if (!response.ok) throw new Error(`The control plane answered ${response.status}.`);
  return response.json();
}
