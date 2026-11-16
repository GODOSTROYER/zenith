/**
 * Generic substitution of cross-partition references in a consumer's manifest fields (PROD-MIX follow-up, round 3).
 *
 * A consumer manifest holds a reference to a value another partition produced as the marker `{{zenith.input.<name>}}`, where
 * `<name>` is one of the typed inputs the operation consumes (`consumer.input` of a declared reference). No driver has to know:
 *
 *  GRAPH LEVEL (`applyTypedInputsToGraph`, run wherever the executable graph is derived, so the plan, the dispatch re-check, the
 *  secret sync and the semantics digest all see the same graph):
 *    - a secret input may appear ONLY as the whole value of a `secretRef` (an env entry `{ key, secretRef }`, or the secret node
 *      expansion made from it). It is replaced by the vault reference the producer sealed the value under, and the secret node
 *      becomes a managed vault secret, so the provider's own secret mechanism (Secret Manager, Key Vault, task secrets) and the
 *      existing secret sync deliver it. The value is never in a graph, a plan, a variable or a workspace file;
 *    - every other marker is validated here and left for the compiler.
 *  COMPILE LEVEL (`rewriteSpecMarkers` / `substituteInputTokens`, used by `compileGraph`): a non-secret input in any string value of a
 *  node's spec (env values, connection strings, URLs, allowlist entries) becomes a placeholder before the driver compiles and the
 *  OpenTofu variable expression `${var.zenith_in_<name>}` (or the bare `var.zenith_in_<name>` where HCL evaluates the token) after,
 *  so the value rides the declared variable (its default is in the configuration digest).
 *
 * REFUSED at plan time (`StepFailedError`, fixed text, node address and input name only, never a value): a marker naming an input the
 * operation does not consume (including every marker of an operation that consumes none); a secret input anywhere except a
 * `secretRef` (a non-secret field); a non-secret input in a `secretRef`; a marker in an object key; a marker that is only part of a
 * `secretRef`; a marker the driver did not carry into the node's compiled output (the field cannot accept it); any placeholder that
 * survives substitution.
 */
import { safeText } from "./text";
import { StepFailedError } from "./errors";
import { scanHclTemplate } from "@/lib/tofu/hcl-template";
import { specDigestOf, graphDigestOf } from "@/lib/resources/expand-support";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import { inputVariable, type ConsumedInput } from "./typed-inputs";

const NAME = "[a-z][a-z0-9_]{0,60}";
const MARKER = new RegExp(`\\{\\{zenith\\.input\\.(${NAME})\\}\\}`, "g");
const WHOLE = new RegExp(`^\\{\\{zenith\\.input\\.(${NAME})\\}\\}$`);
const TOKEN = /__zenith_in_(\d+)__/g;
const MAX_DEPTH = 24;

const refuse = (address: string, text: string): never => { throw new StepFailedError(`${safeText(address, 120)}: ${text}`); };
const markersIn = (text: string): string[] => [...text.matchAll(MARKER)].map((match) => match[1]);
export const hasMarker = (text: string): boolean => text.includes("{{zenith.input.");

interface Found { name: string; whole: boolean; secretField: boolean; path: string }

/** Every marker in a spec, with whether it is the whole value of a `secretRef`. Refuses markers in keys and malformed ones. */
function scan(address: string, value: unknown, path: string[], out: Found[], depth = 0): void {
  if (depth > MAX_DEPTH) return;
  if (typeof value === "string") {
    if (!hasMarker(value)) return;
    const names = markersIn(value);
    if (names.length === 0) refuse(address, `${path.join(".") || "spec"} contains a malformed typed-input reference.`);
    const secretField = path[path.length - 1] === "secretRef";
    for (const name of names) out.push({ name, whole: WHOLE.test(value), secretField, path: path.join(".") });
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => scan(address, item, [...path, String(index)], out, depth + 1)); return; }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (hasMarker(key)) refuse(address, "a typed-input reference cannot be an object key.");
      scan(address, item, [...path, key], out, depth + 1);
    }
  }
}

function validate(address: string, found: readonly Found[], inputs: ReadonlyMap<string, ConsumedInput>): void {
  for (const item of found) {
    const input = inputs.get(item.name);
    if (!input) refuse(address, `${item.path} references the typed input "${safeText(item.name, 60)}", which this operation does not consume.`);
    const secret = input!.type === "secret_ref";
    if (secret && !item.secretField) refuse(address, `${item.path} would place the secret input "${safeText(item.name, 60)}" in a field that is not a secret reference.`);
    if (!secret && item.secretField) refuse(address, `${item.path} is a secret reference but the input "${safeText(item.name, 60)}" is not a secret.`);
    if (secret && !item.whole) refuse(address, `${item.path} must be exactly the secret input reference, not part of a larger value.`);
  }
}

const byName = (inputs: readonly ConsumedInput[]): Map<string, ConsumedInput> => new Map(inputs.map((input) => [input.name, input]));

/** Replace the secret markers of a spec value (only `secretRef` positions reach here, validated). */
function rewriteSecretRefs(value: unknown, inputs: ReadonlyMap<string, ConsumedInput>, depth = 0): { value: unknown; changed: boolean } {
  if (depth > MAX_DEPTH) return { value, changed: false };
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => { const r = rewriteSecretRefs(item, inputs, depth + 1); changed ||= r.changed; return r.value; });
    return { value: changed ? next : value, changed };
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "secretRef" && typeof item === "string") {
        const match = WHOLE.exec(item);
        const input = match ? inputs.get(match[1]) : undefined;
        if (input?.secret) { next[key] = input.secret.ref; changed = true; continue; }
      }
      const r = rewriteSecretRefs(item, inputs, depth + 1);
      changed ||= r.changed;
      next[key] = r.value;
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

/**
 * The graph with secret markers replaced by the vault references the producers sealed, after validating every marker of every node.
 * A graph with no marker is returned as is (same object), so every non-mixed operation is untouched.
 */
export function applyTypedInputsToGraph(graph: ResourceGraph, typed: readonly ConsumedInput[]): ResourceGraph {
  const inputs = byName(typed);
  let touched = false;
  const nodes = graph.nodes.map((node): ResourceNode => {
    const found: Found[] = [];
    scan(node.address, node.spec, [], found);
    if (!found.length) return node;
    validate(node.address, found, inputs);
    const { value, changed } = rewriteSecretRefs(node.spec, inputs);
    if (!changed) return node;
    touched = true;
    const rewritten: ResourceNode = { ...node, spec: value as ResourceNode["spec"] };
    if (node.kind === "secret" && typeof (rewritten.spec as { secretRef?: unknown }).secretRef === "string") {
      // The secret node made from the marker is now a managed vault secret: the provider secret and its sync follow the existing path.
      (rewritten.spec as unknown as Record<string, unknown>).store = "zenith_vault";
      rewritten.ownership = "managed";
      delete (rewritten as { externalRef?: string }).externalRef;
    }
    rewritten.specDigest = specDigestOf(rewritten);
    return rewritten;
  });
  if (!touched) return graph;
  return { ...graph, nodes, graphDigest: graphDigestOf(nodes, graph.edges) };
}

/* ------------------------------ compile level ------------------------------ */

export interface SpecRewrite { node: ResourceNode; used: ReadonlySet<number> }

/** Replace non-secret markers of a node's spec with placeholders `__zenith_in_<index>__`. `indexOf` maps an input name to its index. */
export function rewriteSpecMarkers(node: ResourceNode, inputs: ReadonlyMap<string, ConsumedInput>, indexOf: ReadonlyMap<string, number>): SpecRewrite {
  const found: Found[] = [];
  scan(node.address, node.spec, [], found);
  if (!found.length) return { node, used: new Set() };
  validate(node.address, found, inputs);
  // A secret marker that reaches the compiler was not rewritten at graph level: nothing may carry it forward.
  for (const item of found) if (inputs.get(item.name)!.type === "secret_ref") refuse(node.address, `${item.path} still holds a secret input reference; the graph was not prepared for this operation.`);
  const used = new Set<number>();
  const walk = (value: unknown, depth = 0): unknown => {
    if (depth > MAX_DEPTH) return value;
    if (typeof value === "string") return hasMarker(value) ? value.replace(MARKER, (_m, name: string) => { const index = indexOf.get(name)!; used.add(index); return `__zenith_in_${index}__`; }) : value;
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, walk(item, depth + 1)]));
    return value;
  };
  return { node: { ...node, spec: walk(node.spec) as ResourceNode["spec"] }, used };
}

/**
 * Replace placeholders in the strings (and keys) of a compiled fragment: a placeholder HCL evaluates becomes the bare variable
 * expression, a literal one becomes an interpolation. Anything left over refuses.
 */
export function substituteInputTokens(value: unknown, address: string, names: readonly string[], seen: Set<number>, depth = 0): unknown {
  if (depth > 128) return refuse(address, "the compiled output nests too deeply to substitute typed inputs.");
  if (typeof value === "string") {
    if (!value.includes("__zenith_in_")) return value;
    const expressionOf = (index: number): string => `var.${inputVariable(names[index] ?? refuse(address, "an unknown typed-input placeholder was produced."))}`;
    let roots: Set<string>;
    try { roots = scanHclTemplate(value).roots; } catch { return refuse(address, "a compiled value carrying a typed input could not be parsed as an OpenTofu template."); }
    const replaced = value.replace(/__zenith_in_(\d+)__/g, (token: string, digits: string, offset: number) => {
      const index = Number(digits);
      seen.add(index);
      if (roots.has(token)) return expressionOf(index);
      // Literal occurrence: decide per occurrence by probing, exactly as references are (a literal copy stays literal text around it).
      let probe = `__zenith_probe_${offset}__`;
      while (value.includes(probe)) probe += "_";
      const probed = value.slice(0, offset) + probe + value.slice(offset + token.length);
      let isRoot = false;
      try { isRoot = scanHclTemplate(probed).roots.has(probe); } catch { isRoot = false; }
      return isRoot ? expressionOf(index) : "${" + expressionOf(index) + "}";
    });
    if (replaced.includes("__zenith_in_")) return refuse(address, "a typed-input placeholder survived substitution.");
    return replaced;
  }
  if (Array.isArray(value)) return value.map((item) => substituteInputTokens(item, address, names, seen, depth + 1));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => [substituteInputTokens(key, address, names, seen, depth + 1) as string, substituteInputTokens(item, address, names, seen, depth + 1)] as const);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) return refuse(address, "typed-input substitution produced duplicate keys.");
    return Object.fromEntries(entries);
  }
  return value;
}

/** Indexes of the placeholders present anywhere in a fragment before substitution. */
export function placeholdersIn(value: unknown, into: Set<number> = new Set(), depth = 0): Set<number> {
  if (depth > 128) return into;
  if (typeof value === "string") { for (const match of value.matchAll(TOKEN)) into.add(Number(match[1])); return into; }
  if (Array.isArray(value)) { for (const item of value) placeholdersIn(item, into, depth + 1); return into; }
  if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value as Record<string, unknown>)) { placeholdersIn(key, into, depth + 1); placeholdersIn(item, into, depth + 1); }
  return into;
}
