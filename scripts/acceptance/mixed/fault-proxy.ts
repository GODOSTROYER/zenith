/**
 * A TCP fault proxy: the safe way to blackhole one provider's endpoint from the HARNESS's side (PROD-MIX-07).
 *
 * It sits between a client (the traffic generator) and one target address and can be switched at runtime:
 *   pass       bytes flow both ways
 *   blackhole  new connections are accepted and swallowed, and bytes on connections that are already open stop being
 *              forwarded in both directions: nothing arrives and no answer ever comes (a client sees a timeout, exactly
 *              like a dropped route)
 *   reset      new connections are closed immediately and open ones are destroyed (a client sees a reset)
 * Healing back to `pass` destroys every connection that lost data to the blackhole, as a real network would once
 * retransmissions give up, so a client never receives half of an answer later.
 *
 * It changes nothing in any cloud: it only controls what this process forwards. It binds to loopback unless told
 * otherwise, forwards to exactly one configured target, and is the only "network fault" the harness injects itself.
 * (The cloud-side fault of the live recovery drill is a connection revocation through the control plane's own API.)
 */
import net from "node:net";

export type FaultMode = "pass" | "blackhole" | "reset";

export interface FaultProxy {
  readonly port: number;
  mode(): FaultMode;
  setMode(mode: FaultMode): void;
  stats(): { accepted: number; forwarded: number; swallowed: number; reset: number; dropped: number };
  close(): Promise<void>;
}

export async function startFaultProxy(target: { host: string; port: number }, options: { listenHost?: string; listenPort?: number; initial?: FaultMode } = {}): Promise<FaultProxy> {
  let mode: FaultMode = options.initial ?? "pass";
  const stats = { accepted: 0, forwarded: 0, swallowed: 0, reset: 0, dropped: 0 };
  const open = new Set<net.Socket>();
  /** connections that lost bytes to the blackhole; they are destroyed when the proxy heals */
  const poisoned = new Set<net.Socket>();

  const server = net.createServer((client) => {
    stats.accepted += 1;
    open.add(client);
    client.on("close", () => { open.delete(client); poisoned.delete(client); });
    client.on("error", () => client.destroy());
    if (mode === "reset") { stats.reset += 1; client.destroy(); return; }
    if (mode === "blackhole") {
      stats.swallowed += 1;
      poisoned.add(client);
      client.on("data", () => { stats.dropped += 1; });
      return;
    }
    stats.forwarded += 1;
    const upstream = net.connect(target.port, target.host);
    open.add(upstream);
    upstream.on("close", () => { open.delete(upstream); poisoned.delete(upstream); client.destroy(); });
    upstream.on("error", () => { client.destroy(); upstream.destroy(); });
    client.on("close", () => upstream.destroy());
    // Forward chunk by chunk and look at the mode every time, so a switch to blackhole also stops connections already open.
    client.on("data", (chunk) => {
      if (mode === "blackhole") { stats.dropped += 1; poisoned.add(client); poisoned.add(upstream); return; }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (mode === "blackhole") { stats.dropped += 1; poisoned.add(client); poisoned.add(upstream); return; }
      client.write(chunk);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.listenPort ?? 0, options.listenHost ?? "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fault proxy could not bind.");

  return {
    port: address.port,
    mode: () => mode,
    setMode(next) {
      mode = next;
      if (next === "pass") for (const socket of [...poisoned]) socket.destroy();
      if (next === "reset") for (const socket of [...open]) socket.destroy();
    },
    stats: () => ({ ...stats }),
    close: () => new Promise<void>((resolve) => {
      for (const socket of open) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
