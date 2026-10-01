/**
 * Driver compile-output inertness (WS-SEC): the hook every resource driver's
 * contract test must run.
 *
 * A driver's `compile(node, ctx)` turns a ResourceNode — whose `spec` and
 * `labels` are derived from a manifest, a repository or an import, i.e. from
 * strings an attacker can write — into a `TofuFragment` that a runner executes
 * with real credentials. OpenTofu evaluates `${…}` and `%{…}` inside ANY JSON
 * string of the configuration, so a driver that copies `spec.name` into a
 * string verbatim has made "whatever the repository author typed" into
 * "an expression tofu runs" (`${file("/proc/self/environ")}`). The assembler's
 * scan (`assembleWorkspace`) is the second wall; the first is that drivers
 * escape (`$${`, `%%{`). This helper proves the first wall.
 *
 *     assertDriverStringsInert({
 *       label: "aws.ecs_service@1",
 *       leaves: stringLeavesOf(node),                      // which fields to attack
 *       compile: (attack) => driver.compile!(withLeaf(node, attack), ctx),
 *     });
 *
 * For every hostile string in the `hcl` and `template` corpus categories (plus
 * a few purpose-built ones), every leaf is replaced by the string in turn; the
 * compiled fragment is scanned for LIVE interpolation — a `${` or `%{` that is
 * not escaped — and any live interpolation that the BASELINE compile (benign
 * string in the same leaf) does not also contain is a violation. Drivers
 * legitimately emit live references (`${aws_vpc.main.id}`); what they must not
 * emit is live text that came from the node.
 *
 * Escaping rule (HCL templates), verified against real OpenTofu 1.12.5: a `${`
 * is live ONLY when exactly one `$` precedes the `{`. Two or more (`$${`,
 * `$$${`, …) are literal: the scanner reads the last two as the `$${` escape and
 * every earlier `$` as plain text (`$$${upper("a")}` evaluates to the literal
 * text `$${upper("a")}`). The same holds for `%` and `%%{`.
 */
import type { TofuFragment } from "@/lib/drivers/types";
import { injectionsFor } from "./corpus";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Every `${` / `%{` start in `s` that is live (not escaped), as a snippet of the text that follows it. */
export function liveInterpolations(s: string, snippetLength = 32): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) {
    const c = s[i];
    if ((c === "$" || c === "%") && s[i + 1] === "{") {
      // exactly one `$` (or `%`) before the brace: live. A second one in front turns it into the literal escape.
      if (i === 0 || s[i - 1] !== c) out.push(s.slice(i, i + snippetLength));
    }
  }
  return out;
}

function leaves(value: unknown, path: string, visit: (s: string, where: string) => void): void {
  if (typeof value === "string") return visit(value, path);
  if (Array.isArray(value)) return value.forEach((v, i) => leaves(v, `${path}[${i}]`, visit));
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      visit(k, `${path}.<key:${k}>`);
      leaves(v, `${path}.${k}`, visit);
    }
  }
}

/** All live interpolation snippets anywhere in a fragment (strings and keys). */
export function liveSnippetsOf(fragment: TofuFragment | Json): Set<string> {
  const found = new Set<string>();
  leaves(fragment, "$", (s) => liveInterpolations(s).forEach((x) => found.add(x)));
  return found;
}

/** Hostile strings that are valid for any string leaf: the expression-injection corpus plus markers. */
export const EXPRESSION_ATTACKS: readonly string[] = [
  ...injectionsFor("hcl", "template").map((c) => c.value),
  '${file("/proc/self/environ")}',
  '${file/**/("/proc/self/environ")}',
  '%{ for f in fileset("/", "*") }${f}%{ endfor }',
  '${nonsensitive(data.aws_secretsmanager_secret_version.x.secret_string)}',
  'prefix-${var.x}-suffix',
  '"}\nprovisioner "local-exec" {\n  command = "id"\n}\nx "y" {\n a = "',
];

export interface InertSpec {
  /** names the driver in messages */
  label: string;
  /** build the fragment with `attack` planted in ONE leaf; `baseline` plants a benign string in the same leaf */
  compile(attack: string, leaf: string): TofuFragment;
  /** the node fields (spec keys, label keys, names) to attack, by whatever name `compile` understands */
  leaves: readonly string[];
  attacks?: readonly string[];
}

/** Throw, naming the driver, leaf and payload, if a hostile string becomes live interpolation. */
export function assertDriverStringsInert(spec: InertSpec): void {
  const offenders: string[] = [];
  for (const leaf of spec.leaves) {
    const baseline = liveSnippetsOf(spec.compile("benign-value", leaf));
    for (const attack of spec.attacks ?? EXPRESSION_ATTACKS) {
      let fragment: TofuFragment;
      try {
        fragment = spec.compile(attack, leaf);
      } catch {
        continue; // refusing a hostile string is a valid outcome
      }
      for (const snippet of liveSnippetsOf(fragment)) {
        if (!baseline.has(snippet)) offenders.push(`${spec.label}: leaf "${leaf}" <- ${JSON.stringify(attack.slice(0, 40))} became live interpolation ${JSON.stringify(snippet)}`);
      }
    }
  }
  if (offenders.length) {
    throw new Error(`SECURITY INVARIANT VIOLATED: driver output carries text from the node as live OpenTofu interpolation (${offenders.length}):\n  ${offenders.slice(0, 10).join("\n  ")}`);
  }
}
