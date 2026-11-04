/**
 * A tiny local HTTP server for source tests (Prometheus / Loki API shapes).
 * Binds 127.0.0.1 on an ephemeral port; nothing leaves the machine.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  params: URLSearchParams;
  headers: http.IncomingHttpHeaders;
}

export interface TestServer {
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}

export type Handler = (req: Recorded, res: http.ServerResponse) => void;

export async function startServer(handler: Handler): Promise<TestServer> {
  const requests: Recorded[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rec: Recorded = { method: req.method ?? "GET", path: url.pathname, params: url.searchParams, headers: req.headers };
    requests.push(rec);
    handler(rec, res);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export const json = (res: http.ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** Never answers; the connection stays open until the client gives up. */
export const hang: Handler = () => undefined;
