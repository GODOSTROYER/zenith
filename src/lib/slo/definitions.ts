/**
 * Service and recovery objective definitions (PROD-OPS-01).
 *
 * The data lives in `deploy/slo/slo-definitions.json` (versioned). This module validates it strictly and is the
 * only way the rest of the code reads it. The honesty rule is enforced here, not by convention:
 *
 *   - every objective must carry `status: "provisional"`;
 *   - the file must say `approval.status: "not_approved"` with the pending decision `DEC-BUSINESS`;
 *   - any field that could record an accountable approval (approver, approvedBy, approvedAt, signedOff, ...)
 *     is refused, so a definition file cannot be edited into looking approved. Recording a real approval is a
 *     separate, deliberate change to this validator together with the business decision it records.
 *
 * Pure leaf module (no I/O): the JSON is bundled at build time.
 */
import raw from "../../../deploy/slo/slo-definitions.json";

export const PROVISIONAL_LABEL = "Provisional, not approved";

export type BurnWindow = "5m" | "30m" | "1h" | "6h" | "3d";
export const BURN_WINDOW_SECONDS: Readonly<Record<BurnWindow, number>> = { "5m": 300, "30m": 1800, "1h": 3600, "6h": 21_600, "3d": 259_200 };

export interface BurnAlertDef { name: string; severity: "critical" | "warning" | "info"; longWindow: BurnWindow; shortWindow: BurnWindow; factor: number }

interface Common { id: string; title: string; category: string; status: "provisional"; sli: string }
export interface RatioObjective extends Common { kind: "ratio"; target: number }
export interface LatencyRatioObjective extends Common { kind: "latency_ratio"; target: number; thresholdSeconds: number }
export interface CapacityObjective extends Common { kind: "capacity"; minRequestsPerSecond: number; maxP95Ms: number; maxErrorRate: number }
export interface RecoveryObjective extends Common { kind: "recovery_seconds"; maxSeconds: number }
export type Objective = RatioObjective | LatencyRatioObjective | CapacityObjective | RecoveryObjective;
export type RatioLike = RatioObjective | LatencyRatioObjective;

export interface SloDefinitions {
  schemaVersion: 1;
  definitionVersion: string;
  approval: { status: "not_approved"; pendingDecision: "DEC-BUSINESS"; note: string };
  budgetWindowDays: number;
  burnAlerts: BurnAlertDef[];
  objectives: Objective[];
}

export class SloDefinitionError extends Error {}

const APPROVAL_KEYS = /approv|sign(?:ed)?.?off|accountab|owner|ratif/i;
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

export function parseSloDefinitions(input: unknown): SloDefinitions {
  if (!isObj(input)) return fail("SLO definitions must be an object.");
  const top = new Set(["schemaVersion", "definitionVersion", "approval", "budgetWindowDays", "burnAlerts", "objectives"]);
  for (const k of Object.keys(input)) if (!top.has(k)) fail(`Unknown top-level field ${k}.`);
  if (input.schemaVersion !== 1) fail("schemaVersion must be 1.");
  const definitionVersion = text(input.definitionVersion, "definitionVersion");
  const approval = input.approval;
  if (!isObj(approval) || approval.status !== "not_approved" || approval.pendingDecision !== "DEC-BUSINESS") return fail("approval must be { status: not_approved, pendingDecision: DEC-BUSINESS, note }.");
  for (const k of Object.keys(approval)) if (!["status", "pendingDecision", "note"].includes(k)) fail(`approval.${k} is not allowed: the definition file cannot record an approver.`);
  const note = text(approval.note, "approval.note");
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
    for (const k of Object.keys(o)) if (APPROVAL_KEYS.test(k)) fail(`objectives[${i}].${k} looks like an approval field; targets are provisional and carry no approver.`);
    const kind = o.kind;
    if (typeof kind !== "string" || !(kind in ALLOWED_KEYS)) return fail(`objectives[${i}].kind is invalid.`);
    for (const k of Object.keys(o)) if (!ALLOWED_KEYS[kind].includes(k)) fail(`objectives[${i}].${k} is not allowed for kind ${kind}.`);
    if (o.status !== "provisional") fail(`objectives[${i}].status must be "provisional".`);
    const id = text(o.id, `objectives[${i}].id`);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(id)) fail(`objectives[${i}].id must be a lowercase identifier.`);
    if (seen.has(id)) fail(`Duplicate objective id ${id}.`);
    seen.add(id);
    const common = { id, title: text(o.title, `${id}.title`), category: text(o.category, `${id}.category`), status: "provisional" as const, sli: text(o.sli, `${id}.sli`) };
    switch (kind) {
      case "ratio": return { ...common, kind, target: num(o.target, `${id}.target`, 0.5, 0.999999) };
      case "latency_ratio": return { ...common, kind, target: num(o.target, `${id}.target`, 0.5, 0.999999), thresholdSeconds: num(o.thresholdSeconds, `${id}.thresholdSeconds`, 0.001, 3600) };
      case "capacity": return { ...common, kind, minRequestsPerSecond: num(o.minRequestsPerSecond, `${id}.minRequestsPerSecond`, 0.1, 1_000_000), maxP95Ms: num(o.maxP95Ms, `${id}.maxP95Ms`, 1, 600_000), maxErrorRate: num(o.maxErrorRate, `${id}.maxErrorRate`, 0, 1) };
      default: return { ...common, kind: "recovery_seconds", maxSeconds: num(o.maxSeconds, `${id}.maxSeconds`, 1, 31_536_000) };
    }
  });
  return { schemaVersion: 1, definitionVersion, approval: { status: "not_approved", pendingDecision: "DEC-BUSINESS", note }, budgetWindowDays, burnAlerts, objectives };
}

let cached: SloDefinitions | undefined;
/** The validated definitions bundled with this build. Throws at first use if the file is invalid. */
export function sloDefinitions(): SloDefinitions {
  return (cached ??= parseSloDefinitions(raw));
}

export const isRatioObjective = (o: Objective): o is RatioLike => o.kind === "ratio" || o.kind === "latency_ratio";
export const errorBudgetFraction = (o: RatioLike): number => 1 - o.target;
