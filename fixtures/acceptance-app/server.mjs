/**
 * The Zenith live-acceptance sample app. Dependency-free on purpose: nothing to
 * install, nothing to audit, and a build that cannot fail on a registry.
 *
 *   GET /health   200 {"status":"ok"} whenever the process is serving. It does
 *                 NOT look at the database, so a load balancer keeps the task
 *                 in service while a dependency is broken (Demo B relies on
 *                 that: the outage has to be diagnosed, not merely restarted).
 *   GET /db       TCP connect check against the host:port parsed from
 *                 DATABASE_URL (postgres://user:password@host:5432/dbname). 200 when a connection opens within the timeout,
 *                 503 otherwise ("timeout" when a security group drops the
 *                 packets, "refused" when something answers with a reset).
 *   GET /         a one-line description.
 *
 * What /db proves and what it does not: a completed TCP handshake proves the
 * network path and the security-group rule between this task and the database
 * endpoint. It does NOT authenticate, speak the Postgres wire protocol or run a
 * query, so it says nothing about credentials, TLS or the database's health.
 * That is enough for the security-group scenarios and keeps the app free of a
 * driver.
 *
 * Secrets: DATABASE_URL usually carries a password. It is parsed in memory for
 * the host and port and is never echoed, logged or returned; responses and log
 * lines carry only host, port, reason and timing.
 *
 * Logs: one JSON object per line on stdout (CloudWatch-friendly). A background
 * check (DB_CHECK_INTERVAL_MS, default 15000, 0 disables) logs `db_check` so an
 * outage is visible in the logs without anyone calling /db.
 *
 * Environment: PORT (8080), HOST (0.0.0.0), DATABASE_URL, DB_CONNECT_TIMEOUT_MS
 * (2000), DB_CHECK_INTERVAL_MS (15000), APP_VERSION.
 */
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

const APP = "zenith-acceptance-app";

/** Parse a postgres URL down to host and port. Returns `{ error }` instead of throwing. Credentials are discarded. */
export function parseDatabaseUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return { error: "not_configured" };
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: "invalid_url" };
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return { error: "invalid_url" };
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (host === "") return { error: "invalid_url" };
  const port = url.port === "" ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "invalid_url" };
  return { host, port };
}

/**
 * Open a TCP connection to host:port and close it. Resolves with
 * `{ ok: true, latencyMs }` or `{ ok: false, reason }` where reason is one of
 * `timeout`, `refused`, `dns`, `unreachable`, `error`. Never rejects.
 */
export function tcpCheck(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ ok: true, latencyMs: Date.now() - started }));
    socket.once("timeout", () => finish({ ok: false, reason: "timeout" }));
    socket.once("error", (err) => {
      const code = err && typeof err === "object" ? err.code : undefined;
      if (code === "ECONNREFUSED" || code === "ECONNRESET") return finish({ ok: false, reason: "refused" });
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") return finish({ ok: false, reason: "dns" });
      if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return finish({ ok: false, reason: "unreachable" });
      return finish({ ok: false, reason: "error" });
    });
  });
}

function log(entry) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), app: APP, ...entry })}\n`);
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** One database check, logged. Returns the JSON body and the HTTP status the caller should use. */
export async function checkDatabase(env = process.env, { quiet = false } = {}) {
  const parsed = parseDatabaseUrl(env.DATABASE_URL);
  if ("error" in parsed) {
    if (!quiet) log({ level: "error", event: "db_check", ok: false, reason: parsed.error });
    return { status: 503, body: { db: "unconfigured", reason: parsed.error } };
  }
  const timeoutMs = positiveInt(env.DB_CONNECT_TIMEOUT_MS, 2000) || 2000;
  const result = await tcpCheck(parsed.host, parsed.port, timeoutMs);
  if (result.ok) {
    if (!quiet) log({ level: "info", event: "db_check", ok: true, host: parsed.host, port: parsed.port, latencyMs: result.latencyMs });
    return { status: 200, body: { db: "reachable", host: parsed.host, port: parsed.port, latencyMs: result.latencyMs } };
  }
  if (!quiet) log({ level: "error", event: "db_connect_failed", ok: false, host: parsed.host, port: parsed.port, reason: result.reason, timeoutMs });
  return { status: 503, body: { db: "unreachable", host: parsed.host, port: parsed.port, reason: result.reason } };
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function createApp(env = process.env) {
  return http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method_not_allowed" });
    if (path === "/health") return send(res, 200, { status: "ok", app: APP, version: env.APP_VERSION ?? "dev" });
    if (path === "/db") {
      checkDatabase(env).then(
        (r) => send(res, r.status, r.body),
        () => send(res, 500, { error: "internal_error" }),
      );
      return;
    }
    if (path === "/") return send(res, 200, { app: APP, routes: ["/health", "/db"] });
    return send(res, 404, { error: "not_found" });
  });
}

function main() {
  const port = positiveInt(process.env.PORT, 8080) || 8080;
  const host = process.env.HOST ?? "0.0.0.0";
  const server = createApp(process.env);
  server.listen(port, host, () => log({ level: "info", event: "listening", host, port }));

  const intervalMs = positiveInt(process.env.DB_CHECK_INTERVAL_MS, 15000);
  let timer;
  if (intervalMs > 0 && process.env.DATABASE_URL) {
    timer = setInterval(() => {
      checkDatabase(process.env).catch(() => undefined);
    }, intervalMs);
    timer.unref();
  }

  const shutdown = (signal) => {
    log({ level: "info", event: "shutdown", signal });
    if (timer) clearInterval(timer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
