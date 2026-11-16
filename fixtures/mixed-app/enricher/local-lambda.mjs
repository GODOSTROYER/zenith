/** LocalStack Invoke transport only. Accepts no public cloud endpoint or credentials. */
import https from "node:https";
import { readFileSync } from "node:fs";

if (process.env.ZENITH_LOCAL_TARGETS !== "1") throw new Error("local target gate required");
const endpoint = new URL(process.env.LOCALSTACK_URL ?? "");
if (endpoint.origin !== "http://localstack.zenith-j15.svc.cluster.local:4566") throw new Error("only the dedicated local emulator endpoint is accepted");
https.createServer({
  key: readFileSync("/pki/enricher.key"), cert: readFileSync("/pki/enricher.crt"), ca: readFileSync("/pki/ca.crt"),
  requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2",
}, async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json", "x-enricher-provider": "localstack-aws-lambda" }); res.end(body); };
  if (req.method === "GET" && req.url === "/health") return send(200, '{"status":"ok"}');
  if (req.method !== "POST" || req.url !== "/enrich") return send(404, '{}');
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 4096) return send(413, '{}'); chunks.push(chunk); }
    // Unsigned local emulator Invoke; no SigV4 or cloud identity is claimed.
    const response = await fetch(new URL("/2015-03-31/functions/zenith-j15-enricher/invocations", endpoint), {
      method: "POST", body: Buffer.concat(chunks).toString("utf8"), signal: AbortSignal.timeout(8000), redirect: "error",
    });
    if (!response.ok || response.headers.has("x-amz-function-error")) return send(502, '{}');
    const value = await response.json();
    return send(value.statusCode, value.body);
  } catch { return send(502, '{"error":"localstack_unavailable"}'); }
}).listen(8443, "0.0.0.0");
