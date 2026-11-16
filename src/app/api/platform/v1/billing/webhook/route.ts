/**
 * `POST /api/platform/v1/billing/webhook` - the payment provider's signed webhook (PROD-MAN-06).
 *
 * Classified `webhook-signed`: the middleware lets exactly this POST through without a session cookie, so the signature IS
 * the authentication. The raw body is verified against `ZENITH_BILLING_STRIPE_WEBHOOK_SECRET` before it is parsed or any
 * store is touched (see src/lib/billing/webhook.ts). A redelivered event id changes nothing. In `billing: disabled` mode
 * the route answers 404 and does nothing else.
 */
import { billingConfigFromEnv } from "@/lib/billing/config";
import { handleStripeWebhook, WEBHOOK_MAX_BYTES } from "@/lib/billing/webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Read at most WEBHOOK_MAX_BYTES of the body; undefined when it is larger. */
async function boundedText(req: Request): Promise<string | undefined> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > WEBHOOK_MAX_BYTES) { await reader.cancel().catch(() => undefined); return undefined; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(req: Request): Promise<Response> {
  if (billingConfigFromEnv().mode !== "managed") return reply(404, { error: { code: "billing_disabled", message: "Billing is not enabled on this installation." } });
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > WEBHOOK_MAX_BYTES)) return reply(413, { error: { code: "payload_too_large", message: "The webhook body is too large." } });
  const raw = await boundedText(req);
  if (raw === undefined) return reply(413, { error: { code: "payload_too_large", message: "The webhook body is too large." } });
  const out = await handleStripeWebhook(raw, req.headers.get("stripe-signature"), {
    sql: async () => (await import("@/lib/controlplane/db")).platformDb(),
  });
  return reply(out.status, out.body);
}
