/**
 * Service and recovery objective definitions (PROD-OPS-01).
 *
 * The data lives in `deploy/slo/slo-definitions.json` (versioned). This module validates it strictly and is the
 * only way the rest of the code reads it. The honesty rule is enforced here, not by convention. A file is in
 * exactly one of two states, and mixed files are refused:
 *
 *   - `approval.status: "not_approved"` (pendingDecision DEC-BUSINESS): every objective must carry
 *     `status: "provisional"`. This is what an operator ships with custom, unapproved targets.
 *   - `approval.status: "approved_targets"`: the owner's decision DEC-BUSINESS is recorded with `approvedBy`,
 *     `approvedAt` and `commitment: "engineering_target"`, and every objective must carry `status: "target"`.
 *     The approval records launch ENGINEERING TARGETS only. `commitment` can hold no other value, so the file
 *     cannot express a contractual SLA, and an objective field that claims a service credit, a contract or a
 *     guarantee is refused.
 *
 * Per-objective approval-like fields (approver, signedOff, owner, ...) are refused in both states: the single
 * approval record lives on the `approval` block. An optional `nextMilestone` states an aspiration (for example
 * 99.99% availability); it is never an objective and nothing evaluates it.
 *
 * Pure leaf module (no I/O): the JSON is bundled at build time.
 */
import raw from "../../../deploy/slo/slo-definitions.json";

export const PROVISIONAL_LABEL = "Provisional, not approved";
export const TARGET_LABEL = "Approved launch target, not a contractual SLA";

export type BurnWindow = "5m" | "30m" | "1h" | "6h" | "3d";
export const BURN_WINDOW_SECONDS: Readonly<Record<BurnWindow, number>> = { "5m": 300, "30m": 1800, "1h": 3600, "6h": 21_600, "3d": 259_200 };

export interface BurnAlertDef { name: string; severity: "critical" | "warning" | "info"; longWindow: BurnWindow; shortWindow: BurnWindow; factor: number }

export type ObjectiveStatus = "provisional" | "target";
interface Common { id: string; title: string; category: string; status: ObjectiveStatus; sli: string }
export interface RatioObjective extends Common { kind: "ratio"; target: number }
export interface LatencyRatioObjective extends Common { kind: "latency_ratio"; target: number; thresholdSeconds: number }
export interface CapacityObjective extends Common { kind: "capacity"; minRequestsPerSecond: number; maxP95Ms: number; maxErrorRate: number }
export interface RecoveryObjective extends Common { kind: "recovery_seconds"; maxSeconds: number }
export type Objective = RatioObjective | LatencyRatioObjective | CapacityObjective | RecoveryObjective;
export type RatioLike = RatioObjective | LatencyRatioObjective;

export type Approval =
  | { status: "not_approved"; pendingDecision: "DEC-BUSINESS"; note: string }
  | { status: "approved_targets"; decision: "DEC-BUSINESS"; approvedBy: string; approvedAt: string; commitment: "engineering_target"; note: string };

/** A stated aspiration. Never evaluated as a target by any report or alert. */
export interface NextMilestone { objective: string; target: number; status: "aspiration" }

export interface SloDefinitions {
  schemaVersion: 1;
  definitionVersion: string;
  approval: Approval;
  budgetWindowDays: number;
  burnAlerts: BurnAlertDef[];
  objectives: Objective[];
  nextMilestone?: NextMilestone;
}

export class SloDefinitionError extends Error {}

const APPROVAL_KEYS = /approv|sign(?:ed)?.?off|accountab|owner|ratif/i;
/** Claims an objective must not make: the targets are engineering targets, not a contract. */
const CLAIM_WORDS = /service[\s-]*credit|contractual|guarantee/i;
const ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  ratio: ["id", "title", "category", "status", "kind", "target", "sli"],
  latency_ratio: ["id", "title", "category", "status", "kind", "target", "thresholdSeconds", "sli"],
  capacity: ["id", "title", "category", "status", "kind", "minRequestsPerSecond", "maxP95Ms", "maxErrorRate", "sli"],
  recovery_seconds: ["id", "title", "category", "status", "kind", "maxSeconds", "sli"],
};

const fail = (message: string): never => { throw new SloDefinitionError(message); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, name: string, min: number, max: number): number => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fail(`${name} must be a number between ${min} and ${max}.`));
const text = (v: unknown, name: string): string => (typeof v === "string" && v.trim() !== "" && v.length <= 600 ? v : fail(`${name} must be non-empty text.`));

function isoDate(v: unknown, name: string): string {
  const s = text(v, name);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const full = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s);
  if (!dateOnly && !full) return fail(`${name} must be an ISO date such as 2026-10-13.`);
  const t = Date.parse(s);
  if (Number.isNaN(t) || (dateOnly && new Date(t).toISOString().slice(0, 10) !== s)) return fail(`${name} must be a real calendar date.`);
  return s;
}

function parseApproval(approval: unknown): Approval {
  if (!isObj(approval)) return fail("approval must be an object.");
  if (approval.status === "not_approved") {
    if (approval.pendingDecision !== "DEC-BUSINESS") return fail("approval must be { status: not_approved, pendingDecision: DEC-BUSINESS, note }.");
    for (const k of Object.keys(approval)) if (!["status", "pendingDecision", "note"].includes(k)) fail(`approval.${k} is not allowed while status is not_approved: an unapproved file cannot record an approver.`);
    return { status: "not_approved", pendingDecision: "DEC-BUSINESS", note: text(approval.note, "approval.note") };
  }
  if (approval.status === "approved_targets") {
    for (const k of Object.keys(approval)) if (!["status", "decision", "approvedBy", "approvedAt", "commitment", "note"].includes(k)) fail(`approval.${k} is not allowed.`);
    if (approval.decision !== "DEC-BUSINESS") return fail("approval.decision must be DEC-BUSINESS.");
    if (approval.commitment !== "engineering_target") return fail("approval.commitment must be exactly engineering_target: these targets are not a contractual commitment.");
    return {
      status: "approved_targets", decision: "DEC-BUSINESS",
      approvedBy: text(approval.approvedBy, "approval.approvedBy"), approvedAt: isoDate(approval.approvedAt, "approval.approvedAt"),
      commitment: "engineering_target", note: text(approval.note, "approval.note"),
    };
  }
  return fail("approval.status must be not_approved or approved_targets.");
}

export function parseSloDefinitions(input: unknown): SloDefinitions {
  if (!isObj(input)) return fail("SLO definitions must be an object.");
  const top = new Set(["schemaVersion", "definitionVersion", "approval", "budgetWindowDays", "burnAlerts", "objectives", "nextMilestone"]);
  for (const k of Object.keys(input)) if (!top.has(k)) fail(`Unknown top-level field ${k}.`);
  if (input.schemaVersion !== 1) fail("schemaVersion must be 1.");
  const definitionVersion = text(input.definitionVersion, "definitionVersion");
  const approval = parseApproval(input.approval);
  const expectedStatus: ObjectiveStatus = approval.status === "approved_targets" ? "target" : "provisional";
  const budgetWindowDays = num(input.budgetWindowDays, "budgetWindowDays", 1, 90);

  if (!Array.isArray(input.burnAlerts) || input.burnAlerts.length === 0) return fail("burnAlerts must be a non-empty array.");
  const burnAlerts = (input.burnAlerts as unknown[]).map((b, i): BurnAlertDef => {
    if (!isObj(b)) return fail(`burnAlerts[${i}] must be an object.`);
    const win = (v: unknown, n: string): BurnWindow => (typeof v === "string" && v in BURN_WINDOW_SECONDS ? (v as BurnWindow) : fail(`burnAlerts[${i}].${n} must be one of ${Object.keys(BURN_WINDOW_SECONDS).join(", ")}.`));
    const severity = b.severity;
    if (severity !== "critical" && severity !== "warning" && severity !== "info") return fail(`burnAlerts[${i}].severity is invalid.`);
    const longWindow = win(b.longWindow, "longWindow");
    const shortWindow = win(b.shortWindow, "shortWindow");
    if (BURN_WINDOW_SECONDS[shortWindow] >= BURN_WINDOW_SECONDS[longWindow]) fail(`burnAlerts[${i}] shortWindow must be shorter than longWindow.`);
    return { name: text(b.name, `burnAlerts[${i}].name`), severity, longWindow, shortWindow, factor: num(b.factor, `burnAlerts[${i}].factor`, 0.5, 100) };
  });

  if (!Array.isArray(input.objectives) || input.objectives.length === 0) return fail("objectives must be a non-empty array.");
  const seen = new Set<string>();
  const objectives = (input.objectives as unknown[]).map((o, i): Objective => {
    if (!isObj(o)) return fail(`objectives[${i}] must be an object.`);
    for (const k of Object.keys(o)) if (APPROVAL_KEYS.test(k)) fail(`objectives[${i}].${k} looks like an approval field; the approval is recorded once on the approval block and objectives carry no approver.`);
    const kind = o.kind;
    if (typeof kind !== "string" || !(kind in ALLOWED_KEYS)) return fail(`objectives[${i}].kind is invalid.`);
    for (const k of Object.keys(o)) if (!ALLOWED_KEYS[kind].includes(k)) fail(`objectives[${i}].${k} is not allowed for kind ${kind}.`);
    if (o.status !== expectedStatus) fail(`objectives[${i}].status must be "${expectedStatus}" when approval.status is ${approval.status}.`);
    for (const [k, v] of Object.entries(o)) if (typeof v === "string" && CLAIM_WORDS.test(v)) fail(`objectives[${i}].${k} makes a contractual claim (service credit, contractual or guarantee); these are engineering targets.`);
    const id = text(o.id, `objectives[${i}].id`);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(id)) fail(`objectives[${i}].id must be a lowercase identifier.`);
    if (seen.has(id)) fail(`Duplicate objective id ${id}.`);
    seen.add(id);
    const common = { id, title: text(o.title, `${id}.title`), category: text(o.category, `${id}.category`), status: expectedStatus, sli: text(o.sli, `${id}.sli`) };
    switch (kind) {
      case "ratio": return { ...common, kind, target: num(o.target, `${id}.target`, 0.5, 0.999999) };
      case "latency_ratio": return { ...common, kind, target: num(o.target, `${id}.target`, 0.5, 0.999999), thresholdSeconds: num(o.thresholdSeconds, `${id}.thresholdSeconds`, 0.001, 3600) };
      case "capacity": return { ...common, kind, minRequestsPerSecond: num(o.minRequestsPerSecond, `${id}.minRequestsPerSecond`, 0.1, 1_000_000), maxP95Ms: num(o.maxP95Ms, `${id}.maxP95Ms`, 1, 600_000), maxErrorRate: num(o.maxErrorRate, `${id}.maxErrorRate`, 0, 1) };
      default: return { ...common, kind: "recovery_seconds", maxSeconds: num(o.maxSeconds, `${id}.maxSeconds`, 1, 31_536_000) };
    }
  });

  let nextMilestone: NextMilestone | undefined;
  if (input.nextMilestone !== undefined) {
    const m = input.nextMilestone;
    if (!isObj(m)) return fail("nextMilestone must be an object.");
    for (const k of Object.keys(m)) if (!["objective", "target", "status"].includes(k)) fail(`nextMilestone.${k} is not allowed.`);
    if (m.status !== "aspiration") fail("nextMilestone.status must be aspiration: a milestone is never a current target.");
    const objectiveId = text(m.objective, "nextMilestone.objective");
    const base = objectives.find((x) => x.id === objectiveId);
    if (!base || (base.kind !== "ratio" && base.kind !== "latency_ratio")) return fail("nextMilestone.objective must name a ratio objective in this file.");
    const target = num(m.target, "nextMilestone.target", 0.5, 0.999999);
    if (target <= base.target) fail("nextMilestone.target must be stricter than the current target of that objective.");
    nextMilestone = { objective: objectiveId, target, status: "aspiration" };
  }
  return { schemaVersion: 1, definitionVersion, approval, budgetWindowDays, burnAlerts, objectives, ...(nextMilestone ? { nextMilestone } : {}) };
}

let cached: SloDefinitions | undefined;
/** The validated definitions bundled with this build. Throws at first use if the file is invalid. */
export function sloDefinitions(): SloDefinitions {
  return (cached ??= parseSloDefinitions(raw));
}

/** True when the owner has approved these as launch engineering targets (never a contractual commitment). */
export const targetsApproved = (d: SloDefinitions = sloDefinitions()): boolean => d.approval.status === "approved_targets";
/** The label every report and response carries for these definitions. */
export const sloLabel = (d: SloDefinitions = sloDefinitions()): string => (targetsApproved(d) ? TARGET_LABEL : PROVISIONAL_LABEL);

export const isRatioObjective = (o: Objective): o is RatioLike => o.kind === "ratio" || o.kind === "latency_ratio";
export const errorBudgetFraction = (o: RatioLike): number => 1 - o.target;
