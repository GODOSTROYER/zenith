/**
 * HTTP wrapper for the enricher: POST /enrich with { clientKey, sku, qty }. It labels every answer with the provider it
 * runs on (`ENRICHER_PROVIDER`, default "aws") so the independent readback can prove which cloud served the call.
 * Mutual TLS is the platform's job in front of this process (the protected endpoint); this server speaks plain HTTP
 * on the address it is given and must never be exposed without that endpoint.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import { handler } from "./handler.mjs";

export function createEnricherServer({ provider = process.env.ENRICHER_PROVIDER ?? "aws" } = {}) {
  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "x-enricher-provider": provider });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return send(200, { status: "ok", provider });
    if (req.method !== "POST" || req.url !== "/enrich") return send(404, { error: "not_found" });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) return send(413, { error: "too_large" });
      chunks.push(chunk);
    }
    let event;
    try { event = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return send(400, { error: "invalid_json" }); }
    const result = await handler(event);
    return send(result.statusCode, JSON.parse(result.body));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8081);
  createEnricherServer().listen(port, process.env.HOST ?? "0.0.0.0", () => console.log(JSON.stringify({ event: "listening", app: "mixed-enricher", port })));
}
