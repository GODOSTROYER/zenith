/** Disposable Pebble HTTP-01 server. Never forwards a request. */
import http from "node:http";
import { readFileSync } from "node:fs";
http.createServer((req, res) => {
  const token = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(req.url ?? "")?.[1];
  if (!token || req.method !== "GET") { res.writeHead(404); return res.end(); }
  try { const body = readFileSync(`/challenge/${token}`, "utf8"); res.writeHead(200, { "content-type": "text/plain" }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
}).listen(5002, "0.0.0.0");
