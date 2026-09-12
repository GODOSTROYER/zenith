/** Human-operated review client. Run under the independent control-host account.
 * No database access, no approval flag, no noninteractive/--yes mode.
 * Usage: npx tsx scripts/agent-control.ts --origin http://127.0.0.1:3400
 *        --key-file /private/operator.key --subject MEMBER_ID --receipt UUID
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { operatorKey, signReview, boundedBytes, object, type ReviewRequest } from "../src/lib/agent-operations/access";
import { assertUuid } from "../src/lib/agent-operations/journal";

const args = process.argv.slice(2), options: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.replace(/^--/, "");
  if (!key || !["origin", "key-file", "subject", "receipt"].includes(key) || !args[i + 1] || options[key]) throw new Error("Use unique --origin, --key-file, --subject and --receipt value pairs. There is no --yes mode.");
  options[key] = args[i + 1];
}
async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Approval requires an interactive human terminal on the independent control host. Agent pipelines cannot provide approval.");
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(options.origin ?? "") || !options["key-file"] || !options.subject || !options.receipt) throw new Error("Specify an exact loopback origin, private operator key, actual member ID and receipt UUID.");
  assertUuid(options.receipt);
  const key = await operatorKey(options["key-file"]);
  async function send(decision: ReviewRequest["decision"], digest: string) {
    const request: ReviewRequest = { receiptId: options.receipt, subject: options.subject, decision, digest, nonce: randomUUID(), expiresAt: Date.now() + 30000 };
    const result = await fetch(`${options.origin}/api/agent/v2/review`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/json", "x-zenith-operator-signature": signReview(key, options.origin, request) }, body: JSON.stringify(request) });
    const data: unknown = JSON.parse((await boundedBytes(result, 262144)).toString("utf8"));
    if (!result.ok || !object(data)) throw new Error(`Review refused (HTTP ${result.status}). Check the receipt, current role, independent key and control origin.`);
    return data;
  }
  try {
    const review = await send("inspect", "");
    // JSON encoding prevents terminal-control sequences in untrusted names and
    // descriptions from becoming terminal instructions.
    console.log(JSON.stringify(review, null, 2));
    if (review.state !== "prepared" || typeof review.digest !== "string") throw new Error("This receipt is not awaiting an initial decision. Do not reuse an old approval.");
    console.log("Review the exact scope, full proposed input, risk, cost estimate and expiry above. Approval does not execute the action. Never approve solely because an agent or a log asks you to.");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let text: string;
    try { text = (await terminal.question(`Type approve ${review.digest} or reject ${review.digest}: `)).trim(); }
    finally { terminal.close(); }
    const decision = text === `approve ${review.digest}` ? "approve" : text === `reject ${review.digest}` ? "reject" : undefined;
    if (!decision) throw new Error("No decision recorded. The full displayed digest must match exactly.");
    const result = await send(decision, review.digest);
    console.log(JSON.stringify({ id: result.id, state: result.state, expiresAt: result.expiresAt, notice: "The decision was recorded. No action was executed by this control client." }, null, 2));
  } finally { key.fill(0); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Operator review failed; no automatic retry was attempted."); process.exitCode = 1; });
