/** Node22 fetch adapter for socket-aware MCP v3 execution. The plugin may
 * replace this adapter, but its container still has no IP network. */
import { request } from "node:http";

/** @param {string} socketPath @param {string} audience @param {typeof request} fetchRequest */
export function socketFetch(socketPath, audience, fetchRequest = request) {
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    if (url !== audience || method !== "POST") throw new Error("plugin_transport_refused");
    const body = init.body;
    if (typeof body !== "string" || Buffer.byteLength(body) > 65_536) throw new Error("plugin_transport_refused");
    return new Promise((/** @type {(value: Response) => void} */ done, reject) => {
      // Discard all plugin headers, especially bearers and cookies. The
      // gateway owns the dedicated child credential and upstream protocol.
      const req = fetchRequest({ socketPath, path: "/api/agent/v3/mcp", method: "POST", headers: { "content-type": "application/json" }, signal: init.signal ?? undefined }, (res) => {
        let size = 0; const chunks = [];
        res.on("data", (chunk) => { size += chunk.length; if (size > 1024 * 1024) { res.destroy(); reject(new Error("plugin_transport_refused")); } else chunks.push(chunk); });
        res.on("error", () => reject(new Error("plugin_transport_refused")));
        res.on("end", () => done(new Response([202, 204].includes(res.statusCode) ? null : Buffer.concat(chunks), {
          status: res.statusCode, headers: { "content-type": "application/json" },
        })));
      });
      req.once("error", () => reject(new Error("plugin_transport_refused")));
      req.setTimeout(20_000, () => req.destroy()); req.end(body);
    });
  };
}

if (process.env.ZENITH_MCP_SOCKET && process.env.ZENITH_URL) {
  globalThis.fetch = socketFetch(process.env.ZENITH_MCP_SOCKET, `${process.env.ZENITH_URL}/api/agent/v3/mcp`);
}
