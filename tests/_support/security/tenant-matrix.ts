/**
 * The tenant matrix (WS-SEC): one runner, every module.
 *
 * Invariant 2 of `docs/platform/ARCHITECTURE.md` says cross-tenant negative
 * tests exist for every repository and route. This is the shared harness that
 * makes writing one cheap and makes them all fail the same, readable way.
 *
 * A matrix is `principals × targets`. A principal belongs to one workspace; a
 * target belongs to a workspace too — or to none (`workspaceId: null`), which
 * makes it a PHANTOM: an id of the right shape that never existed. Running
 * `call(principal, target)` for every cell yields an outcome per cell:
 *
 *     tenant matrix: zenith_get_project
 *     principal \ target     prj-a-0001 (own)   prj-b-0001 (foreign)   prj-ghost-9 (phantom)
 *     alice@ws-a             allowed            not_found              not_found
 *     bob@ws-b               not_found          allowed                not_found
 *
 * and `assertIsolated()` checks, in order:
 *
 *  1. Cross-tenant cells refuse, and refuse ONLY as `not_found` or `forbidden`
 *     (`allowedCrossTenantOutcomes` can narrow that to `not_found`). A success
 *     is a tenant breach; an unclassified failure (500, validation error, crash)
 *     is a defect too — a refusal the caller cannot interpret is not a refusal.
 *  2. Phantom cells never succeed.
 *  3. Own-tenant cells succeed (unless the target says `expect: "any"`), so a
 *     test cannot pass by refusing everything.
 *  4. By default (`noExistenceLeak !== false`), a foreign target's refusal is
 *     indistinguishable from the refusal for a phantom of the same `kind`:
 *     same outcome kind, code, status and message (ids masked). Otherwise the
 *     refusal itself confirms the object exists and the id space is
 *     enumerable across tenants. This comparison is only meaningful when the
 *     foreign and phantom calls differ in NOTHING but the object's existence
 *     (same workspace, same project, same shape): if the foreign call is also
 *     refused earlier for a different reason (a foreign workspace id), pass
 *     `noExistenceLeak: false` for that cell family and say why.
 *  5. With `canariesByWorkspace`, nothing a principal receives — successes
 *     included — contains a canary planted in another workspace, in any encoded
 *     form. This catches a "list" or "search" that returns the right rows plus
 *     somebody else's.
 *
 * Adapters normalise how a module reports refusal: `call` may throw (the
 * default classifier reads `status`, `code` and the message) or return
 * `refused("not_found")` for modules that return a result object instead.
 */
import { deepScanForCanaries, formatCanaryHits, type CanaryHit } from "./canaries";

export type OutcomeKind = "allowed" | "not_found" | "forbidden" | "other_refusal";

export interface TenantOutcome {
  kind: OutcomeKind;
  code?: string;
  status?: number;
  message?: string;
  /** the returned value when `kind === "allowed"` (kept for canary scans and assertions) */
  value?: unknown;
  /** the thrown error, when the refusal was an exception */
  error?: unknown;
}

/** Return this from `call` to report a refusal without throwing. */
export interface MatrixRefusal {
  readonly __tenantMatrixRefusal: true;
  kind: Exclude<OutcomeKind, "allowed">;
  code?: string;
  status?: number;
  message?: string;
}

export function refused(kind: MatrixRefusal["kind"], details: { code?: string; status?: number; message?: string } = {}): MatrixRefusal {
  return { __tenantMatrixRefusal: true, kind, ...details };
}

const isRefusal = (v: unknown): v is MatrixRefusal => typeof v === "object" && v !== null && (v as MatrixRefusal).__tenantMatrixRefusal === true;

export interface MatrixPrincipal<M = unknown> {
  /** short label shown in the table and in messages */
  id: string;
  workspaceId: string;
  /**
   * `"none"` marks an ATTACK principal that owns nothing even in its own
   * workspace (a revoked member, a forged credential record): every cell —
   * own targets included — must be refused, and the "own target must succeed"
   * rule does not apply to it.
   */
  ownAccess?: "full" | "none";
  /**
   * Exempt this principal from the existence-leak comparison. Use it for a
   * principal whose GRANT explicitly names a foreign id (a poisoned credential):
   * the grant already told the principal that id is "theirs", so a different
   * refusal for it says nothing the principal did not supply. Cross-tenant
   * access and canary checks still apply in full.
   */
  skipExistenceCheck?: boolean;
  meta?: M;
}

export interface MatrixTarget<M = unknown> {
  id: string;
  /** owning workspace; `null` = phantom (never existed) */
  workspaceId: string | null;
  /** pairs a foreign target with the phantom it must be indistinguishable from */
  kind?: string;
  /** `"any"` waives the "own target must succeed" rule (e.g. an undeployed environment) */
  expect?: "allowed" | "any";
  meta?: M;
}

export interface TenantMatrixSpec<PM = unknown, TM = unknown> {
  /** name of the surface under test, used in messages */
  label: string;
  workspaces: readonly string[];
  principals: readonly MatrixPrincipal<PM>[];
  targets: readonly MatrixTarget<TM>[];
  /** the principal is passed so a phantom can be built under THAT principal's own project */
  call(principal: MatrixPrincipal<PM>, target: MatrixTarget<TM>): Promise<unknown> | unknown;
  /** override how a thrown error maps to an outcome */
  classify?(error: unknown): Omit<TenantOutcome, "value" | "error">;
}

export interface TenantCell {
  principal: MatrixPrincipal;
  target: MatrixTarget;
  ownership: "own" | "foreign" | "phantom";
  outcome: TenantOutcome;
}

export interface IsolationOptions {
  /** default `["not_found", "forbidden"]` */
  allowedCrossTenantOutcomes?: readonly ("not_found" | "forbidden")[];
  /** default true: a foreign target's refusal must equal its phantom's */
  noExistenceLeak?: boolean;
  /** default true: own targets must succeed unless the target says `expect: "any"` */
  ownMustSucceed?: boolean;
  /** canaries planted per workspace; a principal must never receive another workspace's */
  canariesByWorkspace?: Readonly<Record<string, readonly string[]>>;
}

/* ------------------------------- classification ------------------------------ */

const NOT_FOUND_CODE = /not[_-]?found|no[_-]?such|unknown[_-]?(?:id|resource|target)|missing/i;
const FORBIDDEN_CODE = /forbid|denied|scope|membership|unauthor|role|permission|not[_-]?a[_-]?member|access/i;
const NOT_FOUND_TEXT = /does not exist|not found|no permitted record|no authorized target matches|unknown /i;

/** Read `status`/`code`/`message` off whatever a module throws. */
export function defaultClassify(error: unknown): Omit<TenantOutcome, "value" | "error"> {
  const e = (error ?? {}) as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
  const code = typeof e.code === "string" ? e.code : undefined;
  const message = typeof e.message === "string" ? e.message : String(error);
  let kind: OutcomeKind = "other_refusal";
  if (status === 404 || (code !== undefined && NOT_FOUND_CODE.test(code))) kind = "not_found";
  else if (status === 401 || status === 403 || (code !== undefined && FORBIDDEN_CODE.test(code))) kind = "forbidden";
  else if (status === undefined && code === undefined && NOT_FOUND_TEXT.test(message)) kind = "not_found";
  return { kind, code, status, message };
}

const isPhantom = (t: MatrixTarget) => t.workspaceId === null;

function ownershipOf(p: MatrixPrincipal, t: MatrixTarget): TenantCell["ownership"] {
  if (isPhantom(t)) return "phantom";
  return t.workspaceId === p.workspaceId ? "own" : "foreign";
}

/** A comparable fingerprint of an outcome with every known id masked out of the message. */
export function outcomeSignature(outcome: TenantOutcome, maskIds: readonly string[]): string {
  let message = outcome.message ?? "";
  for (const id of [...maskIds].sort((a, b) => b.length - a.length)) if (id.length > 0) message = message.split(id).join("<ID>");
  return [outcome.kind, outcome.code ?? "", outcome.status ?? "", message].join("|");
}

/* ---------------------------------- result ---------------------------------- */

export class TenantMatrixResult {
  constructor(
    readonly spec: Pick<TenantMatrixSpec, "label" | "workspaces">,
    readonly cells: readonly TenantCell[]
  ) {}

  cell(principalId: string, targetId: string): TenantCell {
    const found = this.cells.find((c) => c.principal.id === principalId && c.target.id === targetId);
    if (!found) throw new Error(`tenantMatrix(${this.spec.label}): no cell for principal "${principalId}" x target "${targetId}".`);
    return found;
  }

  /** A fixed-width grid, for failure messages and for the README's examples. */
  table(): string {
    const targets = [...new Map(this.cells.map((c) => [c.target.id, c.target])).values()];
    const principals = [...new Map(this.cells.map((c) => [c.principal.id, c.principal])).values()];
    const head = ["principal \\ target", ...targets.map((t) => `${t.id} (${isPhantom(t) ? "phantom" : t.workspaceId})`)];
    const rows = principals.map((p) => [
      `${p.id}@${p.workspaceId}`,
      ...targets.map((t) => {
        const c = this.cell(p.id, t.id);
        return c.outcome.code && c.outcome.kind !== "allowed" ? `${c.outcome.kind}:${c.outcome.code}` : c.outcome.kind;
      }),
    ]);
    const widths = head.map((_, i) => Math.max(head[i].length, ...rows.map((r) => r[i].length)));
    const line = (r: string[]) => r.map((v, i) => v.padEnd(widths[i])).join("  ");
    return [`tenant matrix: ${this.spec.label}`, line(head), ...rows.map(line)].join("\n");
  }

  /** Every problem found, as sentences. Empty when the surface is isolated. */
  violations(options: IsolationOptions = {}): string[] {
    const allowed = new Set<OutcomeKind>(options.allowedCrossTenantOutcomes ?? ["not_found", "forbidden"]);
    const problems: string[] = [];
    const ids = [...new Set([...this.cells.map((c) => c.target.id), ...this.cells.map((c) => c.principal.id)])];
    const sameKindPhantom = (c: TenantCell) =>
      this.cells.find((o) => o.principal.id === c.principal.id && o.ownership === "phantom" && (o.target.kind ?? "default") === (c.target.kind ?? "default"));

    for (const c of this.cells) {
      const who = `${c.principal.id}@${c.principal.workspaceId} -> ${c.target.id} (${c.ownership})`;
      if (c.ownership === "foreign") {
        if (c.outcome.kind === "allowed") problems.push(`CROSS-TENANT ACCESS: ${who} succeeded; it must be refused.`);
        else if (!allowed.has(c.outcome.kind)) {
          problems.push(
            `UNINTERPRETABLE REFUSAL: ${who} was refused as "${c.outcome.kind}" (code=${c.outcome.code ?? "-"}, status=${c.outcome.status ?? "-"}, message="${(c.outcome.message ?? "").slice(0, 120)}"); ` +
              `a cross-tenant refusal must be one of: ${[...allowed].join(", ")}.`
          );
        }
      } else if (c.ownership === "phantom") {
        if (c.outcome.kind === "allowed") problems.push(`PHANTOM SUCCEEDED: ${who} returned data for an id that never existed.`);
      } else if (c.principal.ownAccess === "none") {
        if (c.outcome.kind === "allowed") problems.push(`REVOKED PRINCIPAL SUCCEEDED: ${who} succeeded although this principal is marked as owning nothing.`);
      } else if (options.ownMustSucceed !== false && (c.target.expect ?? "allowed") === "allowed" && c.outcome.kind !== "allowed") {
        problems.push(`OWN TARGET REFUSED: ${who} was refused as "${c.outcome.kind}" (${c.outcome.message ?? c.outcome.code ?? "no detail"}); the matrix would pass vacuously if it refused everything.`);
      }
    }

    if (options.noExistenceLeak !== false) {
      for (const c of this.cells) {
        if (c.ownership !== "foreign" || c.outcome.kind === "allowed" || c.principal.skipExistenceCheck) continue;
        const phantom = sameKindPhantom(c);
        if (!phantom) continue; // no phantom to compare against: nothing to assert
        const a = outcomeSignature(c.outcome, ids);
        const b = outcomeSignature(phantom.outcome, ids);
        if (a !== b) {
          problems.push(
            `EXISTENCE LEAK: for ${c.principal.id}@${c.principal.workspaceId}, foreign ${c.target.id} is refused as [${a}] but phantom ${phantom.target.id} as [${b}]; ` +
              `the difference confirms the foreign object exists.`
          );
        }
      }
    }

    if (options.canariesByWorkspace) {
      for (const c of this.cells) {
        const foreign = Object.entries(options.canariesByWorkspace)
          .filter(([ws]) => ws !== c.principal.workspaceId)
          .flatMap(([, list]) => [...list]);
        if (foreign.length === 0) continue;
        const payload = { value: c.outcome.value, message: c.outcome.message, error: c.outcome.error };
        const hits: CanaryHit[] = deepScanForCanaries(payload, foreign, { root: `${c.principal.id}->${c.target.id}` });
        if (hits.length) problems.push(`FOREIGN SECRET DELIVERED: ${c.principal.id}@${c.principal.workspaceId} -> ${c.target.id}\n${formatCanaryHits(hits)}`);
      }
    }
    return problems;
  }

  /** Throw, with the table and every violation, unless the surface is isolated. */
  assertIsolated(options: IsolationOptions = {}): void {
    const problems = this.violations(options);
    if (problems.length === 0) return;
    throw new Error(
      `SECURITY INVARIANT VIOLATED: tenant isolation of ${this.spec.label} (docs/platform/ARCHITECTURE.md invariant 2).\n` +
        `${this.table()}\n\n${problems.map((p) => `- ${p}`).join("\n")}`
    );
  }
}

/* ---------------------------------- runner ---------------------------------- */

export async function tenantMatrix<PM = unknown, TM = unknown>(spec: TenantMatrixSpec<PM, TM>): Promise<TenantMatrixResult> {
  for (const p of spec.principals) {
    if (!spec.workspaces.includes(p.workspaceId)) throw new Error(`tenantMatrix(${spec.label}): principal "${p.id}" names unknown workspace "${p.workspaceId}".`);
  }
  for (const t of spec.targets) {
    if (t.workspaceId !== null && !spec.workspaces.includes(t.workspaceId)) throw new Error(`tenantMatrix(${spec.label}): target "${t.id}" names unknown workspace "${t.workspaceId}".`);
  }
  const classify = spec.classify ?? defaultClassify;
  const cells: TenantCell[] = [];
  for (const principal of spec.principals) {
    for (const target of spec.targets) {
      let outcome: TenantOutcome;
      try {
        const value = await spec.call(principal, target);
        outcome = isRefusal(value)
          ? { kind: value.kind, code: value.code, status: value.status, message: value.message }
          : { kind: "allowed", value };
      } catch (error) {
        outcome = { ...classify(error), error };
      }
      cells.push({ principal: principal as MatrixPrincipal, target: target as MatrixTarget, ownership: ownershipOf(principal, target as MatrixTarget), outcome });
    }
  }
  return new TenantMatrixResult({ label: spec.label, workspaces: spec.workspaces }, cells);
}
