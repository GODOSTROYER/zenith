/**
 * Minimal W3C trace-context tracer (PROD-OPS-02). Node runtime only.
 *
 * Spans carry the correlation attributes the dashboards and alerts are built on:
 *   zenith.tenant.id       workspace id
 *   zenith.operation.id    platform operation id (the join key across API, worker and runner)
 *   zenith.operation.class what kind of work: api | dispatch | activity | runner_job | maintenance
 *   zenith.request.id      the per-request id already carried in logs and the x-request-id header
 *
 * Context propagates in-process with AsyncLocalStorage, in over HTTP with the
 * `traceparent` header, and out to logs (`traceId` field, see src/lib/log.ts).
 * Finished spans go to a bounded ring: when it is full the OLDEST span is
 * dropped and counted, so tracing can never grow memory or block a request.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { metricsRegistry } from "./metrics";

export interface SpanContext { traceId: string; spanId: string; sampled: boolean }
export type AttributeValue = string | number | boolean;
export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

export interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startMs: number;
  endMs: number;
  attributes: Record<string, AttributeValue>;
  status: "unset" | "ok" | "error";
  statusMessage?: string;
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

export function parseTraceparent(header: string | null | undefined): SpanContext | undefined {
  if (!header) return undefined;
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header.trim().toLowerCase());
  if (!m || m[1] === "ff") return undefined;
  if (!HEX32.test(m[2]) || /^0+$/.test(m[2]) || !HEX16.test(m[3]) || /^0+$/.test(m[3])) return undefined;
  return { traceId: m[2], spanId: m[3], sampled: (parseInt(m[4], 16) & 1) === 1 };
}

export const formatTraceparent = (c: SpanContext): string => `00-${c.traceId}-${c.spanId}-${c.sampled ? "01" : "00"}`;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  // An all-zero id is invalid in W3C trace context.
  if (buf.every((b) => b === 0)) buf[bytes - 1] = 1;
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface TracerOptions {
  /** head sampling ratio for traces that arrive without a parent decision */
  sampleRatio: number;
  /** ring capacity for finished spans */
  maxBuffered: number;
  random?: () => number;
  now?: () => number;
}

const MAX_ATTR_CHARS = 256;
const MAX_ATTRS = 32;

export class Span {
  private readonly attributes: Record<string, AttributeValue> = {};
  private status: FinishedSpan["status"] = "unset";
  private statusMessage: string | undefined;
  private ended = false;
  readonly startMs: number;
  constructor(
    private readonly tracer: Tracer,
    readonly name: string,
    readonly context: SpanContext,
    private readonly parentSpanId: string | undefined,
    private readonly kind: SpanKind,
    attributes?: Record<string, AttributeValue | undefined>
  ) {
    this.startMs = tracer.now();
    if (attributes) this.setAttributes(attributes);
  }

  setAttribute(key: string, value: AttributeValue | undefined): this {
    if (this.ended || value === undefined || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) return this;
    if (!(key in this.attributes) && Object.keys(this.attributes).length >= MAX_ATTRS) return this;
    this.attributes[key] = typeof value === "string" && value.length > MAX_ATTR_CHARS ? value.slice(0, MAX_ATTR_CHARS) : value;
    return this;
  }

  setAttributes(attributes: Record<string, AttributeValue | undefined>): this {
    for (const [k, v] of Object.entries(attributes)) this.setAttribute(k, v);
    return this;
  }

  setStatus(status: "ok" | "error", message?: string): this {
    if (!this.ended) { this.status = status; this.statusMessage = message?.slice(0, 200); }
    return this;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.context.sampled) return;
    this.tracer.record({
      traceId: this.context.traceId, spanId: this.context.spanId, ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      name: this.name, kind: this.kind, startMs: this.startMs, endMs: this.tracer.now(),
      attributes: { ...this.attributes }, status: this.status, ...(this.statusMessage ? { statusMessage: this.statusMessage } : {}),
    });
  }
}

export class Tracer {
  private readonly ring: FinishedSpan[] = [];
  private readonly als = new AsyncLocalStorage<Span>();
  readonly now: () => number;
  private readonly random: () => number;
  constructor(readonly options: TracerOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** `parent` may be an incoming `traceparent` header, a context, or omitted (the active span is used). */
  startSpan(name: string, init: { kind?: SpanKind; parent?: SpanContext | string | null; attributes?: Record<string, AttributeValue | undefined> } = {}): Span {
    // `null` means "start a new root trace"; `undefined` means "continue the active span, if any".
    const parent: SpanContext | undefined = typeof init.parent === "string" ? parseTraceparent(init.parent)
      : init.parent === undefined ? this.als.getStore()?.context
      : init.parent ?? undefined;
    const context: SpanContext = {
      traceId: parent?.traceId ?? randomHex(16),
      spanId: randomHex(8),
      sampled: parent ? parent.sampled : this.random() < this.options.sampleRatio,
    };
    return new Span(this, name, context, parent?.spanId, init.kind ?? "internal", init.attributes);
  }

  /** Run `fn` with `span` active; ends the span and records errors. */
  async run<T>(span: Span, fn: (span: Span) => Promise<T>): Promise<T> {
    try {
      const out = await this.als.run(span, () => fn(span));
      if (span.context.sampled) span.setStatus("ok");
      return out;
    } catch (error) {
      span.setStatus("error", error instanceof Error ? error.name : "error");
      throw error;
    } finally {
      span.end();
    }
  }

  /** Run `fn` with `span` active, without ending it (the caller ends it). */
  withActive<T>(span: Span, fn: () => T): T { return this.als.run(span, fn); }

  active(): Span | undefined { return this.als.getStore(); }

  record(span: FinishedSpan): void {
    if (this.ring.length >= this.options.maxBuffered) {
      this.ring.shift();
      metricsRegistry().noteDropped("span");
    }
    this.ring.push(span);
  }

  /** Take up to `max` finished spans (oldest first). */
  drain(max = 512): FinishedSpan[] { return this.ring.splice(0, Math.max(0, max)); }
  get buffered(): number { return this.ring.length; }
}

const key = Symbol.for("zenith.ops.tracer.v1");
type G = typeof globalThis & { [key]?: Tracer };

function ratioFromEnv(): number {
  const raw = process.env.ZENITH_OTEL_TRACE_SAMPLE_RATIO?.trim();
  const n = raw === undefined || raw === "" ? 0.1 : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.1;
}

/** Process-wide tracer. */
export function tracer(): Tracer {
  const g = globalThis as G;
  return (g[key] ??= new Tracer({ sampleRatio: ratioFromEnv(), maxBuffered: 2048 }));
}

/** The active trace id, for log correlation. Cheap and never throws. */
export function currentTraceId(): string | undefined {
  try { return ((globalThis as G)[key])?.active()?.context.traceId; } catch { return undefined; }
}
