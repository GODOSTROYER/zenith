/**
 * Web tier of the reference mixed app (runs on GCP compute in the live harness).
 *
 *   POST /orders   { clientKey, sku, qty }  -> asks the enricher (AWS) for the price and checksum, then writes the order
 *                  to PostgreSQL (Azure). 201 on first write, 200 on an idempotent replay of the same clientKey,
 *                  502 when the enricher cannot be reached (nothing written), 503 when the database fails.
 *   GET  /orders/:clientKey                 -> the stored row, or 404
 *   GET  /orders?prefix=<p>                 -> { count } of stored orders whose clientKey starts with the prefix
 *   GET  /health                            -> process is serving (does not touch dependencies)
 *
 * A 201 or 200 is an ACKNOWLEDGEMENT that the row is in the database; the independent readback checks exactly that.
 * Anything else is never an acknowledgement. Each row records the providers that served it (WEB_PROVIDER,
 * ENRICHER_PROVIDER from the enricher's answer) so a reader can prove all three clouds took part.
 *
 * Configuration: PORT, HOST, ENRICHER_URL (http, or https with ENRICHER_CA_FILE / ENRICHER_CERT_FILE / ENRICHER_KEY_FILE
 * for the mutual-TLS protected endpoint; files, never values), ENRICHER_TIMEOUT_MS (3000), WEB_PROVIDER (gcp), STORE and
 * DATABASE_URL_FILE (see stores.mjs).
 */
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createStoreFromEnv } from "./stores.mjs";

const spec = JSON.parse(readFileSync(new URL("../spec.json", import.meta.url), "utf8"));
const KEY = /^[A-Za-z0-9_.:-]{1,100}$/;

function callEnricher(env, payload) {
  const target = new URL("/enrich", env.ENRICHER_URL);
  const secure = target.protocol === "https:";
  const options = { method: "POST", headers: { "content-type": "application/json" }, timeout: Number(env.ENRICHER_TIMEOUT_MS ?? 3000) };
  if (secure) {
    if (env.ENRICHER_CA_FILE) options.ca = readFileSync(env.ENRICHER_CA_FILE);
    if (env.ENRICHER_CERT_FILE && env.ENRICHER_KEY_FILE) { options.cert = readFileSync(env.ENRICHER_CERT_FILE); options.key = readFileSync(env.ENRICHER_KEY_FILE); }
    options.minVersion = "TLSv1.2";
  }
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(target, options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, provider: String(res.headers["x-enricher-provider"] ?? ""), body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("enricher_timeout")));
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw Object.assign(new Error("too_large"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createWebServer({ store, env = process.env }) {
  const webProvider = env.WEB_PROVIDER ?? spec.providers.web;
  return http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (req.method === "GET" && url.pathname === "/health") return send(200, { status: "ok", store: store.kind });
      if (req.method === "GET" && url.pathname === "/orders") {
        const prefix = url.searchParams.get("prefix") ?? "";
        if (!KEY.test(prefix)) return send(400, { error: "invalid_prefix" });
        return send(200, { count: await store.countByPrefix(prefix) });
      }
      const one = /^\/orders\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && one) {
        const key = decodeURIComponent(one[1]);
        if (!KEY.test(key)) return send(400, { error: "invalid_key" });
        const row = await store.getOrder(key);
        return row ? send(200, row) : send(404, { error: "not_found" });
      }
      if (req.method === "POST" && url.pathname === "/orders") {
        let body;
        try { body = await readBody(req); } catch (e) { return send(e.status ?? 400, { error: e.message === "too_large" ? "too_large" : "invalid_json" }); }
        const { clientKey, sku, qty } = body ?? {};
        if (typeof clientKey !== "string" || !KEY.test(clientKey) || typeof sku !== "string" || !Number.isInteger(qty) || qty < 1 || qty > spec.maxQty) return send(400, { error: "invalid_input" });
        const existing = await store.getOrder(clientKey).catch(() => { throw Object.assign(new Error("db"), { status: 503 }); });
        if (existing) return send(200, { ...existing, replay: true });
        let enriched;
        try { enriched = await callEnricher(env, { clientKey, sku, qty }); } catch { return send(502, { error: "enricher_unreachable" }); }
        if (enriched.status !== 200) return send(enriched.status === 422 || enriched.status === 400 ? enriched.status : 502, { error: "enricher_refused" });
        let result;
        try {
          result = await store.insertOrder({ clientKey, sku, qty, priceCents: enriched.body.priceCents, checksum: enriched.body.checksum, webProvider, enricherProvider: enriched.provider });
        } catch { return send(503, { error: "database_unavailable" }); }
        return send(result.created ? 201 : 200, result.row);
      }
      return send(404, { error: "not_found" });
    } catch (e) {
      return send(e?.status ?? 500, { error: e?.status === 503 ? "database_unavailable" : "internal" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = await createStoreFromEnv();
  const port = Number(process.env.PORT ?? 8080);
  createWebServer({ store }).listen(port, process.env.HOST ?? "0.0.0.0", () => console.log(JSON.stringify({ event: "listening", app: "mixed-web", port, store: store.kind })));
}
