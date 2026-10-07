/**
 * Strict separation between the sanitized PlanView and raw plan custody material (PROD-DUR-05). Pure.
 *
 * A PlanView is a bounded projection of attribute NAMES and counts. Raw plan material is anything from encrypted custody
 * or the binary plan itself: sealed records (ciphertext with its IV or tag), the binary plan as bytes or as base64 of its
 * zip container, and members named for plan files or bytes. None of it may appear in a PlanView, an evidence summary, an
 * API or MCP result, or any model-visible value. Detection is structural and by container magic, so it does not depend on
 * a secret-shaped name. Callers use `assertPlanViewOnly` at construction (fail closed) and the model-visible sanitizer
 * replaces anything that still reaches it.
 */
const normalize = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Members that exist only to carry raw plan bytes. */
const BYTE_MEMBERS: ReadonlySet<string> = new Set(["planfile", "planbytes", "rawplan", "tfplan", "binaryplan", "planbinary", "planblob"]);
const SEALED_TAGS: ReadonlySet<string> = new Set(["authtag", "tag", "iv", "nonce"]);
/** OpenTofu saved plans are zip containers: base64 of "PK\x03\x04" starts with UEsDB. Anything long that starts so is a plan. */
const ZIP_BASE64 = /^UEsDB[A-Za-z0-9+/]{120,}={0,2}$/;

export const RAW_PLAN_MARKER = "[REDACTED:raw-plan-material]";

/** True when this one object (not its children) is a sealed record or carries plan bytes. */
export function isRawPlanRecord(node: unknown): boolean {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  const keys = Object.keys(node as Record<string, unknown>).map(normalize);
  if (keys.some(k => BYTE_MEMBERS.has(k))) return true;
  if (keys.includes("ciphertext") && keys.some(k => SEALED_TAGS.has(k))) return true;
  // The manifest's raw binary digest next to its byte count identifies a custody manifest, not a view.
  return keys.includes("rawsha256") && keys.includes("bytes");
}
export function isRawPlanString(value: string): boolean {
  return value.length >= 128 && ZIP_BASE64.test(value);
}
export function isRawPlanBinary(node: unknown): boolean {
  return node instanceof Uint8Array || node instanceof ArrayBuffer;
}

export class RawPlanMaterialError extends Error {
  readonly code = "raw_plan_material";
  constructor(path: string) {
    super(`Raw plan material is not allowed in a PlanView (${path || "root"}).`);
  }
}

/** Throws when raw plan custody material appears anywhere within bounded depth and size. Never echoes a value. */
export function assertPlanViewOnly<T>(value: T, limits: { maxNodes?: number; maxDepth?: number; strings?: boolean } = {}): T {
  const maxNodes = limits.maxNodes ?? 100_000, maxDepth = limits.maxDepth ?? 32;
  let nodes = 0;
  const seen = new WeakSet<object>();
  const walk = (node: unknown, path: string, depth: number): void => {
    if (++nodes > maxNodes || depth > maxDepth) throw new RawPlanMaterialError(path);
    // String content is judged only on request: a PlanView may legitimately echo a (truncated) attribute value. The model-visible sanitizer always judges it.
    if (typeof node === "string") { if (limits.strings === true && isRawPlanString(node)) throw new RawPlanMaterialError(path); return; }
    if (node === null || typeof node !== "object") return;
    if (isRawPlanBinary(node) || isRawPlanRecord(node)) throw new RawPlanMaterialError(path);
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach((child, i) => walk(child, `${path}[${i}]`, depth + 1)); return; }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) walk(child, path ? `${path}.${key.slice(0, 40)}` : key.slice(0, 40), depth + 1);
  };
  walk(value, "", 0);
  return value;
}
/** Non-throwing form for read paths that must fail closed (return no view) rather than raise. */
export function containsRawPlanMaterial(value: unknown, strings = false): boolean {
  try { assertPlanViewOnly(value, { strings }); return false; } catch { return true; }
}
