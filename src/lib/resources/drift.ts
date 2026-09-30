/**
 * Drift v2: the desired graph against what drivers actually read (spec §39).
 *
 * Pure. It takes a `ResourceGraph` and `Observation`s and returns a
 * `DriftReport`; it calls no provider, reads no store, writes nothing. The
 * legacy manifest-level drift in `src/lib/drift` is untouched and still serves
 * the old engine path.
 *
 * The honesty rules that shape it:
 *   - Only attributes the observation marks `known` are compared. `unknown`
 *     never becomes `changed`, and never becomes "matches" either.
 *   - "Could not read it" is a result, not silence: a node with no observation,
 *     or whose presence AND every attribute are unknown, is class `unknown`;
 *     presence `inaccessible` is class `inaccessible`. Both also land in
 *     `unobserved`.
 *   - A node with presence `present` and nothing known about its attributes is
 *     simply not reported: existence is established, nothing else is claimed.
 *   - `extra` is only raised for observations no node owns AND that are tagged
 *     as Zenith's for this environment (or that the caller names explicitly).
 *     A stranger's resource in the same account is not drift.
 *   - Only `managed` nodes are repairable. `external` nodes have no cloud
 *     presence and are skipped. Auto-repair is never eligible for stateful
 *     nodes, identities, opened firewalls or anything of high severity.
 *   - Findings echo desired/observed values, so credential-looking attribute
 *     names are redacted and oversized values truncated.
 */
import { canonical } from "@/lib/controlplane/digest";
import { isPointerKey, looksSecretKey, REDACTED } from "./secrets";
import { STATEFUL_KINDS, type DriftClass, type DriftFinding, type DriftReport, type Observation, type ResourceGraph, type ResourceNode } from "./types";

/** Maps a node's desired spec to the comparable attribute values its driver observes. */
export type ExpectedAttributes = (node: ResourceNode) => Record<string, unknown>;

export interface DriftOptions {
  /** drivers provide this (`ResourceDriver.expectedAttributes`); default is the spec's shallow scalars */
  expectedAttributes?: ExpectedAttributes;
  /** addresses with no node that should be reported as `extra` even without Zenith tags */
  includeExtra?: Iterable<string>;
  /** stamp for the report; wins over `now` */
  computedAt?: string;
  now?: () => Date;
}

/** Shallow string/number/boolean members of the spec. A stand-in until a driver says better. */
export const defaultExpectedAttributes: ExpectedAttributes = (node) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.spec))
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  return out;
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isScalar = (v: unknown): v is string | number | boolean => ["string", "number", "boolean"].includes(typeof v);

/** Cloud APIs return "3" for 3 and "true" for true; compare scalars by their text, structures canonically. */
const sameValue = (a: unknown, b: unknown): boolean =>
  isScalar(a) && isScalar(b) ? String(a) === String(b) : canonical(a) === canonical(b);

const MAX_VALUE_CHARS = 500;

function shown(attribute: string, value: unknown): unknown {
  if (looksSecretKey(attribute) && !isPointerKey(attribute)) return REDACTED;
  if (value !== null && typeof value === "object") {
    const text = canonical(value);
    if (text.length > MAX_VALUE_CHARS) return { truncated: true, characters: text.length };
  }
  if (typeof value === "string" && value.length > MAX_VALUE_CHARS) return `${value.slice(0, MAX_VALUE_CHARS)}…`;
  return value;
}

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

/** One observation per address: the newest; ties broken by content so input order never matters. */
function latestByAddress(observations: readonly Observation[]): Map<string, Observation> {
  const out = new Map<string, Observation>();
  for (const o of observations) {
    const prev = out.get(o.address);
    if (!prev) {
      out.set(o.address, o);
      continue;
    }
    const a = time(prev.observedAt);
    const b = time(o.observedAt);
    if (b > a || (b === a && cmp(canonical(o), canonical(prev)) > 0)) out.set(o.address, o);
  }
  return out;
}

const isStateful = (node: ResourceNode): boolean => (STATEFUL_KINDS as readonly string[]).includes(node.kind);

const OPEN = /^(0\.0\.0\.0\/0|::\/0|\*|any|all|-1|0-65535|1-65535)$/i;
const flatten = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(flatten) : isScalar(v) ? [String(v)] : v === null || v === undefined ? [] : [canonical(v)]);

/** A firewall attribute now admits something the desired rule did not: a world-open CIDR, wildcard port or protocol. */
function firewallOpened(fields: { attribute: string; desired: unknown; observed: unknown }[]): boolean {
  return fields.some((f) => {
    const wanted = new Set(flatten(f.desired).map((s) => s.toLowerCase()));
    return flatten(f.observed).some((o) => OPEN.test(o) && !wanted.has(o.toLowerCase()));
  });
}

const truthy = (v: unknown): boolean => v === true || (typeof v === "string" && v.toLowerCase() === "true");

/** Zenith's tags on the provider object, for this environment. Read from `native.tags` (or `native.labels`). */
function taggedForEnvironment(o: Observation, environmentId: string): boolean {
  const raw = (o.native?.tags ?? o.native?.labels) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return false;
  return truthy(raw["zenith:managed"]) && raw["zenith:environment"] === environmentId;
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;
const CLASS_RANK: Record<DriftClass, number> = { missing: 0, changed: 1, inaccessible: 2, unknown: 3, extra: 4 };

const cleanError = (e: string | undefined): string =>
  e ? ` Provider said: ${e.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, 160)}` : "";

export function computeDriftV2(graph: ResourceGraph, observations: readonly Observation[], opts: DriftOptions = {}): DriftReport {
  const expected = opts.expectedAttributes ?? defaultExpectedAttributes;
  const byAddress = latestByAddress(observations);
  const nodes = new Map(graph.nodes.map((n) => [n.address, n]));
  const findings: DriftFinding[] = [];
  const unobserved = new Set<string>();

  const push = (
    node: ResourceNode,
    cls: DriftClass,
    severity: DriftFinding["severity"],
    explanation: string,
    fields?: DriftFinding["fields"],
    opened = false
  ) => {
    const repairable = node.ownership === "managed" && (cls === "missing" || cls === "changed");
    // High-risk drift is never auto-repaired: stateful data, identities, opened firewalls, anything high.
    const autoRepairEligible = repairable && severity !== "high" && !isStateful(node) && node.kind !== "identity" && !opened;
    findings.push({ address: node.address, class: cls, severity, ...(fields ? { fields } : {}), repairable, autoRepairEligible, explanation });
  };

  for (const node of graph.nodes) {
    if (node.ownership === "external") continue; // documented only: no cloud presence to drift from
    const obs = byAddress.get(node.address);
    const stateful = isStateful(node);
    const who = node.ownership === "managed" ? node.address : `${node.address} (${node.ownership})`;

    if (!obs) {
      unobserved.add(node.address);
      push(node, "unknown", "low", `${who} was not observed: no driver has read it, so nothing is known about it — this is not a match.`);
      continue;
    }

    if (obs.presence === "inaccessible") {
      unobserved.add(node.address);
      push(node, "inaccessible", "medium", `Zenith cannot read ${who}: access was denied or the account is unreachable, so its state is unverified.${cleanError(obs.error)}`);
      continue;
    }

    if (obs.presence === "missing") {
      const severity = stateful ? "high" : "medium";
      push(
        node,
        "missing",
        severity,
        stateful
          ? `${who} is in the desired graph but the provider reports it missing. If it was deleted outside Zenith its data is gone; recreating it makes an empty one.`
          : `${who} is in the desired graph but the provider reports it missing.${node.ownership === "managed" ? " Re-applying recreates it." : " Zenith does not manage it and will not recreate it."}`
      );
      continue;
    }

    const knownKeys = Object.entries(obs.attributes).filter(([, v]) => v.state === "known");
    if (obs.presence === "unknown" && knownKeys.length === 0) {
      unobserved.add(node.address);
      push(node, "unknown", "low", `${who} could not be read: presence and every attribute are unknown.${cleanError(obs.error)}`);
      continue;
    }

    // Present (or unknown-but-partially-read): compare only what was actually read.
    const want = expected(node);
    const raw: { attribute: string; desired: unknown; observed: unknown }[] = [];
    for (const attribute of Object.keys(want).sort(cmp)) {
      const desired = want[attribute];
      const seen = obs.attributes[attribute];
      if (desired === undefined || !seen || seen.state !== "known") continue;
      if (!sameValue(desired, seen.value)) raw.push({ attribute, desired, observed: seen.value });
    }
    if (raw.length === 0) continue;

    const opened = node.kind === "firewall" && firewallOpened(raw);
    const risky = raw.some((f) => /public/i.test(f.attribute) && truthy(f.observed) && !truthy(f.desired));
    const severity: DriftFinding["severity"] = node.kind === "identity" || opened || risky ? "high" : "medium";
    const fields = raw.map((f) => ({ attribute: f.attribute, desired: shown(f.attribute, f.desired), observed: shown(f.attribute, f.observed) }));
    const why = node.kind === "identity" ? " An identity changed outside Zenith can widen access." : opened ? " The rule now admits more than the desired graph allows." : risky ? " It is now publicly reachable." : "";
    push(
      node,
      "changed",
      severity,
      `${who} differs from the desired graph on ${raw.map((f) => f.attribute).join(", ")}.${why}`,
      fields,
      opened
    );
  }

  // Extra: something Zenith tagged for this environment (or the caller named) that no node owns.
  const include = new Set(opts.includeExtra ?? []);
  for (const [address, obs] of byAddress) {
    if (nodes.has(address) || obs.presence === "missing") continue;
    if (!include.has(address) && !taggedForEnvironment(obs, graph.environmentId)) continue;
    const kind = address.slice(0, Math.max(0, address.indexOf("/")));
    const sensitive = (STATEFUL_KINDS as readonly string[]).includes(kind) || kind === "firewall" || kind === "identity";
    findings.push({
      address,
      class: "extra",
      severity: sensitive ? "medium" : "low",
      repairable: false,
      autoRepairEligible: false,
      explanation: `${address} exists in this environment${include.has(address) ? "" : " and is tagged as Zenith-managed"}, but no node in the desired graph owns it. Zenith will not change it; adopt it as a referenced resource or remove it deliberately.`,
    });
  }

  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || CLASS_RANK[a.class] - CLASS_RANK[b.class] || cmp(a.address, b.address)
  );

  return {
    environmentId: graph.environmentId,
    graphDigest: graph.graphDigest,
    computedAt: opts.computedAt ?? (opts.now ?? (() => new Date()))().toISOString(),
    findings,
    unobserved: [...unobserved].sort(cmp),
    simulated: observations.some((o) => o.simulated),
  };
}
