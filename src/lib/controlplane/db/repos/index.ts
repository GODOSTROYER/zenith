/**
 * The repositories, as one namespace per table family.
 *
 * Every repository function takes a `Sql` as its first argument, so they
 * compose inside one transaction:
 *
 *     await db.tx(async (tx) => {
 *       const lease = await leases.assertFence(tx, scope, fence);
 *       const op = await operations.transition(tx, { … });
 *       await events.append(tx, { … });
 *     });
 *
 * `bindRepos(sql)` returns the same functions with `sql` pre-applied, for code
 * that wants `repos.operations.get(ws, id)` instead of threading the argument.
 * Bind to the `tx` you were handed, not to the top-level handle, when the calls
 * must commit together.
 */
import type { Sql } from "@/lib/controlplane/types";
import * as approvals from "./approvals";
import * as connections from "./connections";
import * as cost from "./cost";
import * as drift from "./drift";
import * as events from "./events";
import * as evidence from "./evidence";
import * as grants from "./grants";
import * as idempotency from "./idempotency";
import * as incidents from "./incidents";
import * as jobs from "./jobs";
import * as leases from "./leases";
import * as machines from "./machines";
import * as nonces from "./nonces";
import * as observations from "./observations";
import * as operations from "./operations";
import * as policyDecisions from "./policy-decisions";
import * as resources from "./resources";
import * as runners from "./runners";
import * as settings from "./settings";

export {
  approvals,
  connections,
  cost,
  drift,
  events,
  evidence,
  grants,
  idempotency,
  incidents,
  jobs,
  leases,
  machines,
  nonces,
  observations,
  operations,
  policyDecisions,
  resources,
  runners,
  settings,
};

/** A module whose functions take `Sql` first, rewritten to omit it. */
export type Bound<M> = {
  [K in keyof M as M[K] extends (sql: Sql, ...args: never[]) => unknown ? K : never]: M[K] extends (sql: Sql, ...args: infer A) => infer R
    ? (...args: A) => R
    : never;
};

/** Exports that are pure helpers, not repository functions: they take no `Sql`. */
const PURE_HELPERS = new Set(["toOperation", "generateRegistrationToken", "hashRegistrationToken"]);

function bind<M extends object>(mod: M, sql: Sql): Bound<M> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === "function" && !PURE_HELPERS.has(name)) out[name] = (...args: unknown[]) => (value as (...a: unknown[]) => unknown)(sql, ...args);
  }
  return out as Bound<M>;
}

export function bindRepos(sql: Sql) {
  return {
    approvals: bind(approvals, sql),
    connections: bind(connections, sql),
    cost: bind(cost, sql),
    drift: bind(drift, sql),
    events: bind(events, sql),
    evidence: bind(evidence, sql),
    grants: bind(grants, sql),
    idempotency: bind(idempotency, sql),
    incidents: bind(incidents, sql),
    jobs: bind(jobs, sql),
    leases: bind(leases, sql),
    machines: bind(machines, sql),
    nonces: bind(nonces, sql),
    observations: bind(observations, sql),
    operations: bind(operations, sql),
    policyDecisions: bind(policyDecisions, sql),
    resources: bind(resources, sql),
    runners: bind(runners, sql),
    settings: bind(settings, sql),
  };
}

export type PlatformRepos = ReturnType<typeof bindRepos>;
