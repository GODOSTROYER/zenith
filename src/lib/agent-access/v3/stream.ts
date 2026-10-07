/**
 * Streaming, resumable replies and client cancellation for MCP v3 (PROD-UX-02).
 *
 * What streams: a `tools/call` that carries `params._meta.progressToken` and
 * accepts `text/event-stream` is answered as Server-Sent Events: `notifications/
 * progress` while the tool runs, then the result. Every event is stored
 * (platform.mcp_stream_events) under an id `<streamId>.<seq>` BEFORE it is
 * written, so a dropped connection never loses the result.
 *
 * Resume: `GET /api/agent/v3/mcp` with `Last-Event-ID` and the same bearer
 * replays everything after that id and, while the request is still running,
 * follows it until the result (or the time budget) and then ends the stream;
 * the client reconnects again with its newest id. A stream is bound to the
 * principal that opened it (workspace + subject + credential [+ plugin grant]).
 * Another principal, another workspace, an expired stream and a made-up id are
 * the same 404.
 *
 * Cancel: `notifications/cancelled` aborts the in-flight request of the SAME
 * principal. In-process through a registry, and across serverless instances
 * through `cancel_requested_at`, which an in-flight streamed request polls. A
 * dropped connection is NOT a cancel (MCP spec); it cancels nothing.
 *
 * Not offered: a standalone GET notification stream (405 per spec), sessions
 * (`Mcp-Session-Id`), server-initiated requests.
 */
import { createHash } from "node:crypto";
import type { EventStore } from "@modelcontextprotocol/server";
import type { Sql } from "@/lib/controlplane/types";
import * as mcpStreams from "@/lib/controlplane/db/repos/mcp-streams";
import type { AgentIdentity } from "./principal";

export function principalKeyOf(identity: AgentIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify(["zenith-mcp-stream/1", identity.workspaceId, identity.subject, identity.integrationId, identity.plugin?.grantId ?? null]))
    .digest("hex");
}

export interface StreamEventRecord {
  seq: number;
  message: unknown;
}

/** Durable stream storage. Production: platform Postgres/PGlite. Every method is bound to the authenticated identity. */
export interface McpStreamPort {
  open(identity: AgentIdentity, input: { streamId: string; requestId: string; protocolVersion: string }): Promise<void>;
  append(identity: AgentIdentity, streamId: string, message: unknown): Promise<number>;
  /** null when this principal has no such unexpired stream */
  read(identity: AgentIdentity, streamId: string, afterSeq: number): Promise<StreamEventRecord[] | null>;
  /** lifecycle of this principal's unexpired stream; null when there is none */
  status(identity: AgentIdentity, streamId: string): Promise<"open" | "completed" | "cancelled" | null>;
  requestCancel(identity: AgentIdentity, requestId: string): Promise<number>;
  cancelRequested(identity: AgentIdentity, streamId: string): Promise<boolean>;
  finish(identity: AgentIdentity, streamId: string, status: "completed" | "cancelled"): Promise<void>;
}

export function sqlStreamPort(sql: () => Promise<Sql>): McpStreamPort {
  return {
    async open(identity, input) {
      await mcpStreams.openStream(await sql(), { workspaceId: identity.workspaceId, principalKey: principalKeyOf(identity), ...input });
    },
    async append(identity, streamId, message) {
      return mcpStreams.appendStreamEvent(await sql(), { workspaceId: identity.workspaceId, principalKey: principalKeyOf(identity), streamId, payload: message });
    },
    async read(identity, streamId, afterSeq) {
      const rows = await mcpStreams.readStreamEvents(await sql(), { workspaceId: identity.workspaceId, principalKey: principalKeyOf(identity), streamId, afterSeq });
      return rows ? rows.map((r) => ({ seq: r.seq, message: r.payload })) : null;
    },
    async status(identity, streamId) {
      return mcpStreams.streamStatus(await sql(), { workspaceId: identity.workspaceId, principalKey: principalKeyOf(identity), streamId });
    },
    async requestCancel(identity, requestId) {
      return mcpStreams.requestStreamCancel(await sql(), { workspaceId: identity.workspaceId, principalKey: principalKeyOf(identity), requestId });
    },
    async cancelRequested(identity, streamId) {
      return mcpStreams.streamCancelRequested(await sql(), { workspaceId: identity.workspaceId, streamId });
    },
    async finish(identity, streamId, status) {
      await mcpStreams.finishStream(await sql(), { workspaceId: identity.workspaceId, streamId, status });
    },
  };
}

/* ------------------------------ event ids -------------------------------- */

const EVENT_ID = /^([0-9a-f]{32})\.([1-9][0-9]{0,5})$/;
export const eventIdOf = (streamId: string, seq: number): string => `${streamId}.${seq}`;
export function parseEventId(value: string | null): { streamId: string; seq: number } | undefined {
  const match = value ? EVENT_ID.exec(value.trim()) : null;
  return match ? { streamId: match[1], seq: Number(match[2]) } : undefined;
}
/** The SDK names POST streams with a UUID; the durable id is its 32 hex characters. */
const durableId = (sdkStreamId: string): string => {
  const hex = sdkStreamId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("Unsupported stream.");
  return hex;
};

const isFinalFor = (message: unknown, requestId: string): boolean => {
  if (typeof message !== "object" || message === null) return false;
  const m = message as { id?: unknown; result?: unknown; error?: unknown };
  return (m.result !== undefined || m.error !== undefined) && String(m.id) === requestId;
};

/**
 * The SDK `EventStore` for ONE streamed request. The SDK calls `storeEvent`
 * for the priming event, each progress notification and the final result, in
 * order; writes are serialized so sequence numbers match emission order.
 * Replay is not routed through the SDK (see `resumeStream`).
 */
export class RequestEventStore implements EventStore {
  private chain: Promise<unknown> = Promise.resolve();
  private opened = false;
  finalSeen = false;
  /** the durable id once the SDK has opened its first event */
  durableStreamId: string | undefined;

  constructor(
    private readonly port: McpStreamPort,
    private readonly identity: AgentIdentity,
    private readonly requestId: string,
    private readonly protocolVersion: string,
    private readonly onFinal: () => void
  ) {}

  storeEvent(streamId: string, message: unknown): Promise<string> {
    const next = this.chain.then(async () => {
      const id = durableId(streamId);
      this.durableStreamId = id;
      if (!this.opened) {
        await this.port.open(this.identity, { streamId: id, requestId: this.requestId, protocolVersion: this.protocolVersion });
        this.opened = true;
      }
      const seq = await this.port.append(this.identity, id, message);
      if (isFinalFor(message, this.requestId)) {
        this.finalSeen = true;
        await this.port.finish(this.identity, id, "completed").catch(() => undefined);
        this.onFinal();
      }
      return eventIdOf(id, seq);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return parseEventId(eventId)?.streamId;
  }

  async replayEventsAfter(): Promise<string> {
    throw new Error("Replay is served by resumeStream, not by the SDK transport.");
  }
}

/* ------------------------ in-flight cancellation -------------------------- */

const flights = new Map<string, Set<AbortController>>();
const flightKey = (identity: AgentIdentity, requestId: string): string => `${principalKeyOf(identity)}:${requestId}`;

export interface Flight {
  readonly controller: AbortController;
  done(): void;
}

/** Register an in-flight JSON-RPC request so `notifications/cancelled` can reach it on this instance. */
export function registerFlight(identity: AgentIdentity, requestId: string): Flight {
  const key = flightKey(identity, requestId);
  const controller = new AbortController();
  let set = flights.get(key);
  if (!set) flights.set(key, (set = new Set()));
  set.add(controller);
  return {
    controller,
    done() {
      const current = flights.get(key);
      current?.delete(controller);
      if (current && current.size === 0) flights.delete(key);
    },
  };
}

/** Abort this principal's in-flight request(s) with that id on this instance. Returns how many were aborted. */
export function cancelFlights(identity: AgentIdentity, requestId: string, reason: unknown): number {
  const set = flights.get(flightKey(identity, requestId));
  if (!set) return 0;
  let n = 0;
  for (const controller of set) {
    if (!controller.signal.aborted) {
      controller.abort(reason);
      n += 1;
    }
  }
  return n;
}

/** Poll the durable cancel flag of a streamed request and abort `flight` when it is set. Returns a stopper. */
export function watchDurableCancel(port: McpStreamPort, identity: AgentIdentity, streamIdProvider: () => string | undefined, flight: AbortController, intervalMs = 750): () => void {
  const timer = setInterval(() => {
    const id = streamIdProvider();
    if (!id || flight.signal.aborted) return;
    port.cancelRequested(identity, id).then((requested) => { if (requested && !flight.signal.aborted) flight.abort(new Error("cancelled")); }, () => undefined);
  }, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/* ------------------------------- resume ----------------------------------- */

const sseFrame = (id: string, message: unknown): string => `event: message\nid: ${id}\ndata: ${JSON.stringify(message)}\n\n`;

const isMessage = (value: unknown): boolean => typeof value === "object" && value !== null && "jsonrpc" in (value as object);

export interface ResumeOptions {
  /** how long one resumed connection follows a still-running request (default 40s, under maxDuration) */
  followMs?: number;
  pollMs?: number;
  keepAliveMs?: number;
}

/**
 * Serve `GET` + `Last-Event-ID`. The caller has authenticated the bearer; the
 * identity decides which streams exist. Returns null (caller answers 404) when
 * the id is malformed, unknown, expired or belongs to someone else.
 */
export async function resumeStream(port: McpStreamPort, identity: AgentIdentity, lastEventId: string | null, signal: AbortSignal, options: ResumeOptions = {}): Promise<Response | null> {
  const parsed = parseEventId(lastEventId);
  if (!parsed) return null;
  const first = await port.read(identity, parsed.streamId, parsed.seq);
  if (first === null) return null;
  const followMs = options.followMs ?? 40_000;
  const pollMs = options.pollMs ?? 500;
  const keepAliveMs = options.keepAliveMs ?? 15_000;
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let after = parsed.seq;
      let done = false;
      const write = (chunk: string) => { try { controller.enqueue(encoder.encode(chunk)); } catch { done = true; } };
      const emit = (rows: StreamEventRecord[]) => {
        for (const row of rows) {
          after = row.seq;
          if (isMessage(row.message)) write(sseFrame(eventIdOf(parsed.streamId, row.seq), row.message));
          if (isMessage(row.message) && ((row.message as { result?: unknown }).result !== undefined || (row.message as { error?: unknown }).error !== undefined)) done = true;
        }
      };
      emit(first);
      // A finished stream has nothing more to follow, even when the client already holds its last event.
      // Re-read once after seeing the terminal state so an event appended in between is not lost.
      const settle = async (): Promise<void> => {
        if (done || !(await port.status(identity, parsed.streamId).then((s) => s !== "open", () => false))) return;
        emit((await port.read(identity, parsed.streamId, after)) ?? []);
        done = true;
      };
      timer = setInterval(() => write(": keepalive\n\n"), keepAliveMs);
      (timer as { unref?: () => void }).unref?.();
      const deadline = Date.now() + followMs;
      try {
        if (first.length === 0) await settle();
        while (!done && !signal.aborted && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          const rows = await port.read(identity, parsed.streamId, after);
          if (rows === null) break;
          emit(rows);
          if (rows.length === 0) await settle();
        }
      } catch { /* the client reconnects with its newest id */ }
      finally {
        if (timer) clearInterval(timer);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() { if (timer) clearInterval(timer); },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", "x-content-type-options": "nosniff", "x-accel-buffering": "no" } });
}

export const notFoundStream = (): Response =>
  Response.json({ error: { code: "stream_not_found", message: "No such stream for this connection. Start the request again with the same idempotency key.", retryable: false } },
    { status: 404, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
