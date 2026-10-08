/** Explicit AWS Lambda/API Gateway variant; the container uses handler.mjs. */
import { handler as enrich } from "./handler.mjs";

export async function handler(event) {
  let payload = event;
  if (typeof event?.body === "string") {
    if (Buffer.byteLength(event.body) > 4096) return { statusCode: 413, body: JSON.stringify({ error: "too_large" }) };
    try { payload = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: "invalid_json" }) }; }
  }
  const result = await enrich(payload);
  return { ...result, headers: { "content-type": "application/json", "x-enricher-provider": "aws" } };
}
