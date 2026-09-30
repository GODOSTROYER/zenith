/**
 * The capability broker's front door (ADR-0007): `propose`, `check` and
 * `authorizeRead`. Every interface — REST, MCP, the UI, the Navigator, the
 * reconciler — submits the same `CapabilityRequest` here and gets the same
 * kind of answer.
 *
 *   propose        validate → resolve scope server-side → decide → persist the
 *                  decision and an operation (approved | awaiting_approval |
 *                  denied), idempotently, with events
 *   check          the same decision, dry-run: nothing persisted, nothing logged
 *   authorizeRead  read-only capabilities: an ephemeral decision and a short
 *                  grant, NO operation row (no write amplification); the
 *                  decision is logged at most once per minute per
 *                  principal + capability + scope + outcome (in-process window)
 *
 * The broker — not the model, not the client — decides. A foreign id and a
 * missing id are the same `not_found`; a non-member is told the same.
 */
import { digest } from "@/lib/controlplane/digest";
import type { CapabilityGrantClaims, OperationProposal, Principal } from "@/lib/controlplane/types";
import type { ZodError } from "zod";
import { capability as catalogEntry, CapabilityRequestSchema, type CapabilityDef, type CapabilityRequest } from "./catalog";
import { BrokerError } from "./errors";
import { evaluate, raiseRisk, buildPlanFacts, type Evaluation } from "./evaluate";
import { newId, requesterOf } from "./internal";
import type { BrokerDeps, NewEvent } from "./ports";
import { findSecret } from "./secret-guard";
import type { BrokerProposal, CheckResult, ConstraintValue, DecisionView, ProposeContext, ProposeResult, ReadAuthorization } from "./types";
import { decisionView, operationView } from "./views";

const MAX_INPUT_JSON = 64 * 1024;
const MAX_CONSTRAINTS = 50;
const MAX_REASON_DETAIL = 500;
export const READ_GRANT_DEFAULT_SEC = 120;
export const READ_GRANT_MAX_SEC = 300;
export const READ_EVENT_WINDOW_MS = 60_000;

/* ------------------------------ request parsing ----------------------------- */

function describeIssues(error: ZodError): string {
  const parts = error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`);
  return parts.join(", ") + (error.issues.length > 8 ? `, and ${error.issues.length - 8} more` : "");
}

export interface ParsedRequest {
  request: CapabilityRequest;
  def: CapabilityDef;
  /** the input normalized to plain JSON; `null` when absent */
  input: unknown;
  constraints?: Record<string, ConstraintValue>;
  reason?: string;
}

/** Schema + bounds + secret refusal. Error text carries field paths and issue codes, never values. */
export function parseRequest(raw: unknown): ParsedRequest {
  const parsed = CapabilityRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BrokerError("invalid_request", `The capability request is invalid (${describeIssues(parsed.error)}).`, "Send { capability, scope, input?, constraints?, requestedDurationSec?, reason?, idempotencyKey? }.");
  }
  const request = parsed.data;
  const def = catalogEntry(request.capability);

  let constraints: Record<string, ConstraintValue> | undefined;
  if (request.constraints) {
    const entries = Object.entries(request.constraints);
    if (entries.length > MAX_CONSTRAINTS) throw new BrokerError("invalid_request", `constraints may hold at most ${MAX_CONSTRAINTS} members.`);
    constraints = {};
    for (const [key, value] of entries) {
      const ok = value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 1000);
      if (!ok) throw new BrokerError("invalid_request", `constraints.${key.slice(0, 60).replace(/[^A-Za-z0-9_.-]/g, "?")} must be a string (max 1000 characters), a finite number, a boolean or null.`);
      constraints[key] = value as ConstraintValue;
    }
  }

  let input: unknown = null;
  if (request.input !== undefined) {
    let text: string | undefined;
    try {
      text = JSON.stringify(request.input);
    } catch {
      text = undefined;
    }
    if (text === undefined) throw new BrokerError("invalid_request", "input must be JSON-serializable.");
    if (text.length > MAX_INPUT_JSON) throw new BrokerError("invalid_request", `input is too large (max ${MAX_INPUT_JSON / 1024} KiB); pass references and digests, not content.`);
    input = JSON.parse(text);
  }

  for (const [label, value] of [
    ["input", input],
    ["constraints", constraints],
    ["reason", request.reason],
  ] as const) {
    const secret = findSecret(value, label);
    if (secret) {
      throw new BrokerError(
        "secret_material",
        `Refusing the request: ${secret.what} at ${secret.path}. Pass references (vault:…, ARNs, secret names), never secret values.`,
        "Remove the value and pass a reference instead.",
        { path: secret.path }
      );
    }
  }

  return { request, def, input, constraints, reason: request.reason };
}

/* --------------------------------- proposals -------------------------------- */

const oneLine = (text: string, max: number): string => text.replace(/[\r\n\t\u0000-\u001f]+/g, " ").trim().slice(0, max);

function describeScope(scope: { projectId?: string; environmentId?: string; resourceId?: string }, env?: string): string {
  const parts: string[] = [];
  if (scope.resourceId) parts.push(`resource ${scope.resourceId}`);
  if (scope.environmentId) parts.push(`environment ${scope.environmentId}${env ? ` (${env})` : ""}`);
  else if (scope.projectId) parts.push(`project ${scope.projectId}`);
  return parts.length ? ` on ${parts.join(" in ")}` : "";
}

export function buildProposal(args: { parsed: ParsedRequest; evaluation: Evaluation; ctx: ProposeContext; planDigest?: string }): BrokerProposal {
  const { parsed, evaluation, ctx } = args;
  const { def } = parsed;
  const scope = evaluation.resolved.scope;
  const plan = evaluation.input.plan;
  const details: string[] = [`Capability: ${def.name}`, `Risk: ${evaluation.risk}`];
  if (def.destructive) details.push("Destructive: this may destroy data or availability.");
  if (def.escapeHatch) details.push("Escape hatch: an unrestricted execution surface; the strongest gates apply.");
  if (scope.workspaceId) details.push(`Workspace: ${scope.workspaceId}`);
  if (scope.projectId) details.push(`Project: ${scope.projectId}`);
  if (scope.environmentId) details.push(`Environment: ${scope.environmentId}${evaluation.resolved.environment ? ` (${evaluation.resolved.environment.class})` : ""}`);
  if (scope.resourceId) details.push(`Resource: ${scope.resourceId}${evaluation.resolved.resource ? ` (${evaluation.resolved.resource.address})` : ""}`);
  if (parsed.constraints && Object.keys(parsed.constraints).length > 0) {
    details.push(`Requested constraints: ${Object.keys(parsed.constraints).sort().map((k) => `${k}=${String(parsed.constraints![k])}`).join(", ").slice(0, 500)}`);
  }
  if (parsed.request.requestedDurationSec !== undefined) details.push(`Requested grant duration: ${parsed.request.requestedDurationSec}s`);
  if (plan) {
    details.push(`Plan: ${plan.create} to create, ${plan.update} to update, ${plan.delete} to delete, ${plan.replace} to replace`);
    if (plan.destroysData) details.push(`Destroys stateful data: ${plan.destroyedStatefulAddresses.slice(0, 10).join(", ")}${plan.destroyedStatefulAddresses.length > 10 ? ", …" : ""}`);
    if (plan.costDeltaUsdMonthly !== undefined) details.push(`Estimated monthly cost change: ${plan.costDeltaUsdMonthly >= 0 ? "+" : "-"}$${Math.abs(plan.costDeltaUsdMonthly).toFixed(2)}`);
  }
  if (parsed.reason) details.push(`Reason given by the requester (unverified text): ${oneLine(parsed.reason, MAX_REASON_DETAIL)}`);

  const proposal: BrokerProposal = {
    capability: def.name,
    scope,
    input: parsed.input,
    summary: `${def.title}${describeScope(scope, evaluation.resolved.environment?.class)}`,
    details,
    risk: evaluation.risk,
    ...(args.planDigest ? { planDigest: args.planDigest } : {}),
    ...(plan?.costDeltaUsdMonthly !== undefined ? { costDeltaUsd: plan.costDeltaUsdMonthly } : {}),
    ...(ctx.via ? { origin: { tool: ctx.via } } : {}),
    broker: {
      v: 1,
      ...(ctx.via ? { via: ctx.via } : {}),
      ...(parsed.constraints ? { requestedConstraints: parsed.constraints } : {}),
      ...(parsed.request.requestedDurationSec !== undefined ? { requestedDurationSec: parsed.request.requestedDurationSec } : {}),
      risk: evaluation.risk,
      ...(plan ? { plan } : {}),
    },
  };
  return proposal;
}

const cleanPrincipal = (p: Principal): Principal => ({
  kind: p.kind,
  id: p.id,
  name: oneLine(p.name || p.id, 200),
  ...(p.onBehalfOf ? { onBehalfOf: p.onBehalfOf } : {}),
  ...(p.integrationId ? { integrationId: p.integrationId } : {}),
});

const environmentView = (evaluation: Evaluation): DecisionView["environment"] =>
  evaluation.resolved.environment && evaluation.autonomy
    ? { id: evaluation.resolved.environment.id, class: evaluation.resolved.environment.class, autonomyLevel: evaluation.autonomy.level, autonomyIsDefault: evaluation.autonomy.defaulted }
    : undefined;

function evaluationRequest(parsed: ParsedRequest, principal: Principal, ctx: ProposeContext) {
  const facts = buildPlanFacts(ctx.plan, ctx.cost);
  return {
    facts,
    planDigest: ctx.plan?.planDigest,
    req: {
      def: parsed.def,
      scope: parsed.request.scope,
      principal,
      risk: raiseRisk(parsed.def.risk, ctx.risk),
      requestedDurationSec: parsed.request.requestedDurationSec,
      constraints: parsed.constraints,
      plan: facts,
      planDigest: ctx.plan?.planDigest,
      origin: ctx.origin,
    },
  };
}

/** Reasons as event data: codes only, bounded. Messages are fixed text but the codes are what auditors filter on. */
const reasonCodes = (reasons: { code: string }[]): string[] => reasons.slice(0, 20).map((r) => r.code);

/* ---------------------------------- propose --------------------------------- */

export async function propose(deps: BrokerDeps, rawRequest: unknown, principalIn: Principal, ctx: ProposeContext = {}): Promise<ProposeResult> {
  const principal = cleanPrincipal(principalIn);
  const parsed = parseRequest(rawRequest);
  const { req, facts } = evaluationRequest(parsed, principal, ctx);
  const evaluation = await evaluate(deps, req);
  const { decision, evaluated } = evaluation;

  const proposal = buildProposal({ parsed, evaluation, ctx, planDigest: ctx.plan?.planDigest });
  const status = decision.outcome === "allow" ? "approved" : decision.outcome === "require_approval" ? "awaiting_approval" : "denied";
  const operationId = newId(deps, "op");
  const decisionId = newId(deps, "pol");
  const correlationId = ctx.correlationId ?? newId(deps, "corr");
  const scope = evaluation.resolved.scope;
  const base = { workspaceId: scope.workspaceId, projectId: scope.projectId, environmentId: scope.environmentId, resourceId: scope.resourceId, operationId, correlationId, actor: principal };

  const events: NewEvent[] = [
    { ...base, type: "operation.proposed", data: { capability: parsed.def.name, risk: evaluation.risk, status, via: ctx.via ?? null, proposalDigest: digest(proposal) } },
    {
      ...base,
      type: "policy.evaluated",
      data: {
        kind: "propose",
        outcome: decision.outcome,
        reasons: reasonCodes(decision.reasons),
        policyVersion: evaluated.policyVersion,
        inputDigest: evaluated.inputDigest,
        ...(decision.approval ? { approval: decision.approval } : {}),
        autonomyLevel: evaluation.autonomy?.level ?? null,
        autonomyIsDefault: evaluation.autonomy?.defaulted ?? null,
      },
    },
  ];
  if (status === "denied") events.push({ ...base, type: "operation.denied", data: { capability: parsed.def.name, reasons: reasonCodes(decision.reasons) } });

  const idempotencyKey = parsed.request.idempotencyKey
    ? `idem_${digest({ k: principal.kind, p: principal.id, c: parsed.def.name, key: parsed.request.idempotencyKey })}`
    : undefined;
  const requestHash = digest({
    capability: parsed.def.name,
    scope: parsed.request.scope,
    input: parsed.input,
    constraints: parsed.constraints ?? null,
    requestedDurationSec: parsed.request.requestedDurationSec ?? null,
    reason: parsed.reason ?? null,
    principal: { kind: principal.kind, id: principal.id },
    planDigest: ctx.plan?.planDigest ?? null,
    cost: facts ? { d: facts.costDeltaUsdMonthly ?? null, p: facts.projectedMonthlyUsd ?? null } : null,
    risk: ctx.risk ?? null,
  });

  const created = await deps.store.createOperation({
    id: operationId,
    decisionId,
    workspaceId: scope.workspaceId,
    principal,
    proposal: proposal as OperationProposal,
    status,
    approvalRequired: status === "awaiting_approval",
    decision: {
      policyVersion: evaluated.policyVersion,
      inputDigest: evaluated.inputDigest,
      outcome: decision.outcome,
      reasons: decision.reasons,
      ...(decision.approval ? { approval: decision.approval } : {}),
      ...(decision.constraints ? { constraints: decision.constraints } : {}),
    },
    idempotencyKey,
    requestHash,
    correlationId,
    ttlMs: ctx.ttlMs ?? 24 * 60 * 60 * 1000,
    events,
  });

  return {
    operation: operationView(created.operation),
    decision: decisionView(created.decision, { risk: evaluation.risk, environment: created.created ? environmentView(evaluation) : undefined }),
    replayed: !created.created,
  };
}

/* ----------------------------------- check ---------------------------------- */

/** The decision `propose` would reach now, persisting and logging nothing. */
export async function check(deps: BrokerDeps, rawRequest: unknown, principalIn: Principal, ctx: ProposeContext = {}): Promise<CheckResult> {
  const principal = cleanPrincipal(principalIn);
  const parsed = parseRequest(rawRequest);
  const { req } = evaluationRequest(parsed, principal, ctx);
  const evaluation = await evaluate(deps, req);
  return {
    decision: decisionView(
      {
        outcome: evaluation.decision.outcome,
        reasons: evaluation.decision.reasons,
        approval: evaluation.decision.approval,
        constraints: evaluation.decision.constraints,
        policyVersion: evaluation.evaluated.policyVersion,
        inputDigest: evaluation.evaluated.inputDigest,
        evaluatedAt: evaluation.evaluated.evaluatedAt,
      },
      { risk: evaluation.risk, environment: environmentView(evaluation) }
    ),
  };
}

/* -------------------------------- authorizeRead ----------------------------- */

type ReadLog = Map<string, number>;
const readLogs = new WeakMap<object, ReadLog>();
const READ_LOG_MAX_KEYS = 10_000;

/**
 * True at most once per `READ_EVENT_WINDOW_MS` for one principal + capability +
 * scope + outcome. In-process: each server instance keeps its own window, so a
 * fleet logs at most once per minute PER INSTANCE. Bounded: when the map fills,
 * expired entries go first, then the oldest.
 */
function shouldLogRead(deps: BrokerDeps, key: string): boolean {
  let log = readLogs.get(deps.store);
  if (!log) {
    log = new Map();
    readLogs.set(deps.store, log);
  }
  const now = deps.clock.now().getTime();
  const last = log.get(key);
  if (last !== undefined && now - last < READ_EVENT_WINDOW_MS) return false;
  log.delete(key);
  log.set(key, now);
  if (log.size > READ_LOG_MAX_KEYS) {
    for (const [k, t] of log) {
      if (log.size <= READ_LOG_MAX_KEYS && now - t < READ_EVENT_WINDOW_MS) break;
      log.delete(k);
    }
  }
  return true;
}

/**
 * Decide a read-only capability. Nothing is written except (at most once per
 * minute per principal + capability + scope + outcome) one `policy.evaluated`
 * event. On `allow` the caller gets a short-lived grant (default 120 s, never
 * more than 300 s) for the executing surface; it is NOT recorded in the grants
 * table and is not single-use — it is bounded by expiry, audience, capability
 * and scope, and is read-only by construction.
 */
export async function authorizeRead(
  deps: BrokerDeps,
  rawRequest: unknown,
  principalIn: Principal,
  options: { audience?: string; ctx?: ProposeContext } = {}
): Promise<ReadAuthorization> {
  const principal = cleanPrincipal(principalIn);
  const parsed = parseRequest(rawRequest);
  if (parsed.def.mutates) {
    throw new BrokerError("invalid_request", `${parsed.def.name} changes things; submit it with propose, not authorizeRead.`);
  }
  const { req } = evaluationRequest(parsed, principal, options.ctx ?? {});
  const evaluation = await evaluate(deps, req);
  const { decision, evaluated } = evaluation;
  const view = decisionView(
    {
      outcome: decision.outcome,
      reasons: decision.reasons,
      approval: decision.approval,
      constraints: decision.constraints,
      policyVersion: evaluated.policyVersion,
      inputDigest: evaluated.inputDigest,
      evaluatedAt: evaluated.evaluatedAt,
    },
    { risk: evaluation.risk, environment: environmentView(evaluation) }
  );

  const scope = evaluation.resolved.scope;
  const logKey = [scope.workspaceId, principal.kind, principal.id, parsed.def.name, scope.projectId ?? "", scope.environmentId ?? "", scope.resourceId ?? "", decision.outcome].join("|");
  if (shouldLogRead(deps, logKey)) {
    await deps.store.appendEvent({
      type: "policy.evaluated",
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      resourceId: scope.resourceId,
      correlationId: options.ctx?.correlationId ?? newId(deps, "corr"),
      actor: principal,
      data: { kind: "read", capability: parsed.def.name, outcome: decision.outcome, reasons: reasonCodes(decision.reasons), policyVersion: evaluated.policyVersion, inputDigest: evaluated.inputDigest, window: "60s per principal+capability+scope+outcome" },
    });
  }
  if (decision.outcome !== "allow") return { decision: view };

  const now = deps.clock.now();
  const iat = Math.floor(now.getTime() / 1000);
  const policySec = typeof decision.constraints?.grantDurationSec === "number" ? decision.constraints.grantDurationSec : READ_GRANT_DEFAULT_SEC;
  const lifetime = Math.max(1, Math.min(policySec, READ_GRANT_MAX_SEC));
  const jti = newId(deps, "grd");
  const claims: CapabilityGrantClaims = {
    jti,
    iss: deps.issuer ?? "zenith-control",
    aud: options.audience ?? "worker",
    sub: requesterOf(principal),
    iat,
    exp: iat + lifetime,
    cap: parsed.def.name,
    op: `read:${jti}`,
    digest: digest({ capability: parsed.def.name, scope, input: parsed.input, constraints: parsed.constraints ?? null }),
    ws: scope.workspaceId,
    ...(scope.projectId ? { proj: scope.projectId } : {}),
    ...(scope.environmentId ? { env: scope.environmentId } : {}),
    ...(scope.resourceId ? { res: scope.resourceId } : {}),
    ...(decision.constraints ? { constraints: decision.constraints } : {}),
  };
  try {
    await deps.signer.ready();
    return { decision: view, grant: await deps.signer.sign(claims), claims };
  } catch (error) {
    if (error instanceof BrokerError) throw error;
    throw new BrokerError("signer_unavailable", "The read grant could not be signed.");
  }
}

