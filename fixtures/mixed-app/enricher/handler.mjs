/**
 * Enricher: the AWS-hosted part of the reference mixed app. A pure function from { sku, qty } to a price and a
 * checksum, shaped like a Lambda handler (`handler(event)` returning { statusCode, body }) so the same code runs behind
 * `server.mjs` (a container service) or as a function. It holds no state and no secrets.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const spec = JSON.parse(readFileSync(new URL("../spec.json", import.meta.url), "utf8"));

export function priceCents(sku, qty) {
  const unit = spec.catalogCents[sku];
  if (unit === undefined) return undefined;
  return unit * qty;
}

export function checksumOf(fields) {
  const parts = spec.checksum.fields.map((name) => String(fields[name]));
  return createHash(spec.checksum.algorithm).update(`${spec.checksum.salt}${spec.checksum.separator}${parts.join(spec.checksum.separator)}`).digest("hex");
}

export async function handler(event) {
  const sku = event?.sku;
  const qty = event?.qty;
  const clientKey = event?.clientKey;
  if (typeof sku !== "string" || !Number.isInteger(qty) || qty < 1 || qty > spec.maxQty || typeof clientKey !== "string" || clientKey.length < 1 || clientKey.length > 100) {
    return { statusCode: 400, body: JSON.stringify({ error: "invalid_input" }) };
  }
  const price = priceCents(sku, qty);
  if (price === undefined) return { statusCode: 422, body: JSON.stringify({ error: "unknown_sku" }) };
  return { statusCode: 200, body: JSON.stringify({ priceCents: price, checksum: checksumOf({ clientKey, sku, qty, priceCents: price }) }) };
}
