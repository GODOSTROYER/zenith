/**
 * The Cloudflare runtime shapes these workers use, declared here rather than
 * pulled from `@cloudflare/workers-types`.
 *
 * Two reasons. This wave adds no dependency (`npm install` is out of scope for
 * every workstream), and these files are not part of the Next build — they are
 * sources an operator bundles separately — so the only thing that must
 * typecheck them is the repository's own `tsc --noEmit`. Declaring the four
 * shapes we actually use keeps that honest and keeps the surface visible: if a
 * worker starts using a capability, it has to be written down here first.
 *
 * These are structural declarations, not a compatibility claim: nothing below
 * has been run on Cloudflare. See README.md in this directory.
 *
 * Workstream W6 (hosted R3).
 */

/** One D1 statement's outcome. `changes` is what a conditional write is judged by. */
declare interface D1Meta {
  changes: number;
  last_row_id: number;
  rows_read?: number;
  rows_written?: number;
}

declare interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

declare interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

declare interface D1Database {
  prepare(query: string): D1PreparedStatement;
  /** Documented as one transaction; a conditional write that matches no row is not a failure. */
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/** A worker that can be invoked with a request — what a dispatch namespace hands back. */
declare interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/** The Workers for Platforms dispatch binding. `get` never runs anything by itself. */
declare interface DispatchNamespace {
  get(name: string): Fetcher;
}

declare interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
