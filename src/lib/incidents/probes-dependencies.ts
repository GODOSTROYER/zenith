/**
 * Dependency probes: data stores (database, cache, queue, object store),
 * secrets, workload identity and plain compute instances.
 *
 *   db.exists / db.available            cache.exists / cache.available
 *   queue.exists / queue.available      storage.exists
 *   secret.present / secret.resolution_error
 *   identity.exists / identity.access_denied
 *   compute.running
 *
 * Secrets: only PRESENCE is ever read. The probe never asks for, stores or
 * prints a value; the only string it carries is the reference already in the
 * graph (`vault:…`, an ARN, a name). Identity: the provider's IAM state is not
 * re-derived here; "denied" is inferred from AccessDenied-style log lines of
 * the owning workload (matched by signature only), and `identity.exists` from
 * the observation's presence.
 */
import type { Observation } from "@/lib/resources/types";
import type { ProbeContext } from "./probe-context";
import type { Probe } from "./probe-types";
import { parseSignals, plural } from "./probe-util";
import { hitData } from "./probes-workload";
import { sanitizeText } from "./sanitize";
import type { Evidence, Hop } from "./types";

function presenceEvidence(ctx: ProbeContext, hop: Hop, address: string, check: string, o: Observation, noun: string): Evidence {
  const common = { hop, address, check, simulated: o.simulated, source: o.source, observedAt: o.observedAt };
  if (o.presence === "present") return ctx.evidence({ ...common, outcome: "pass", finding: `${noun} ${address} exists.`, data: { presence: "present" } });
  if (o.presence === "missing") return ctx.evidence({ ...common, outcome: "fail", finding: `${noun} ${address} is in the desired graph but the provider reports it missing.`, data: { presence: "missing" } });
  const why = o.presence === "inaccessible" ? "access to read it was denied" : "the provider did not say";
  return ctx.evidence({ ...common, outcome: "unknown", finding: `Whether ${noun.toLowerCase()} ${address} exists is unknown (${why})${o.error ? `: ${sanitizeText(o.error, 160)}` : ""}.`, data: { presence: o.presence } });
}

/* -------------------------------- data stores ------------------------------- */

function storeProbe(hop: "database" | "cache" | "queue" | "storage", prefix: string, noun: string, withRuntime: boolean): Probe {
  const checks = withRuntime ? [`${prefix}.exists`, `${prefix}.available`] : [`${prefix}.exists`];
  const probe: Probe = {
    id: hop,
    hop,
    checks,
    async run(step, ctx) {
      const address = step.address;
      const out: Evidence[] = [];
      const got = await ctx.observe(address);
      if (!got.ok) out.push(ctx.unknown(hop, address, `${prefix}.exists`, got.message));
      else {
        const e = presenceEvidence(ctx, hop, address, `${prefix}.exists`, got.value, noun);
        e.data = { ...e.data, kind: step.kind };
        out.push(e);
      }
      if (!withRuntime) return out;

      const rt = await ctx.runtime(address);
      if (!rt.ok) return [...out, ctx.unknown(hop, address, `${prefix}.available`, rt.message)];
      const r = rt.value;
      const sig = parseSignals(r);
      const status = sig.dbStatus ? sanitizeText(sig.dbStatus, 48) : undefined;
      const common = { hop, address, check: `${prefix}.available`, simulated: r.simulated, source: r.source, observedAt: r.observedAt };
      const data = { health: r.health, status: status ?? null, kind: step.kind, signals: sig.all.slice(0, 6) };
      if (r.health === "healthy") out.push(ctx.evidence({ ...common, outcome: "pass", finding: `${noun} ${address} is available${status ? ` (status ${status})` : ""}.`, data }));
      else if (r.health === "unhealthy" || r.health === "degraded")
        out.push(ctx.evidence({ ...common, outcome: "fail", finding: `${noun} ${address} is ${r.health}${status ? ` (status ${status})` : ""}.`, data }));
      else out.push(ctx.evidence({ ...common, outcome: "unknown", finding: `The state of ${noun.toLowerCase()} ${address} was not read${sig.readFailed ? ` (${sanitizeText(sig.readFailed, 40)})` : ""}.`, data }));
      return out;
    },
  };
  return probe;
}

export const databaseProbe = storeProbe("database", "db", "Database", true);
export const cacheProbe = storeProbe("cache", "cache", "Cache", true);
export const queueProbe = storeProbe("queue", "queue", "Queue", true);
export const storageProbe = storeProbe("storage", "storage", "Object store", false);

/* --------------------------------- compute ---------------------------------- */

export const computeProbe: Probe = {
  id: "compute",
  hop: "compute",
  checks: ["compute.running"],
  async run(step, ctx) {
    const address = step.address;
    const rt = await ctx.runtime(address);
    if (!rt.ok) return [ctx.unknown("compute", address, "compute.running", rt.message)];
    const r = rt.value;
    const common = { hop: "compute" as const, address, check: "compute.running", simulated: r.simulated, source: r.source, observedAt: r.observedAt, data: { health: r.health } };
    if (r.health === "healthy") return [ctx.evidence({ ...common, outcome: "pass", finding: `${address} is running and healthy.` })];
    if (r.health === "unknown") return [ctx.evidence({ ...common, outcome: "unknown", finding: `The state of ${address} was not read.` })];
    return [ctx.evidence({ ...common, outcome: "fail", finding: `${address} is ${r.health}.` })];
  },
};

/* --------------------------------- secrets ---------------------------------- */

export const secretProbe: Probe = {
  id: "secret",
  hop: "secret",
  checks: ["secret.present", "secret.resolution_error"],
  async run(step, ctx) {
    const address = step.address;
    const node = ctx.node(address);
    const ref = (node?.spec as { secretRef?: string } | undefined)?.secretRef;
    const out: Evidence[] = [];

    const got = await ctx.observe(address);
    if (!got.ok) out.push(ctx.unknown("secret", address, "secret.present", got.message, { secretRef: ref ?? null }));
    else {
      const o = got.value;
      const common = { hop: "secret" as const, address, check: "secret.present", simulated: o.simulated, source: o.source, observedAt: o.observedAt };
      // only presence is read; nothing else of the observation is carried into evidence
      const data = { presence: o.presence, secretRef: ref ?? null, ownership: node?.ownership ?? null };
      if (o.presence === "present") out.push(ctx.evidence({ ...common, outcome: "pass", finding: `Secret ${address} exists; its value was not read.`, data }));
      else if (o.presence === "missing") out.push(ctx.evidence({ ...common, outcome: "fail", finding: `Secret ${address} (${sanitizeText(ref ?? "no reference", 120)}) is referenced by ${step.owner ?? "a workload"} but does not exist.`, data }));
      else out.push(ctx.evidence({ ...common, outcome: "unknown", finding: `Whether secret ${address} exists is unknown (${o.presence === "inaccessible" ? "access to read it was denied" : "the provider did not say"}).`, data }));
    }

    const owner = step.owner;
    if (!owner) return out;
    const text = await ctx.text(owner);
    if (!text.ok) return [...out, ctx.unknown("secret", address, "secret.resolution_error", text.message)];
    const hit = text.value.hits.find((h) => h.signature === "secret_error");
    const common = { hop: "secret" as const, address, check: "secret.resolution_error", simulated: text.value.simulated };
    if (hit) out.push(ctx.evidence({ ...common, outcome: "fail", finding: `${owner} logged ${plural(hit.count, "error")} fetching a secret.`, data: hitData(hit) }));
    else if (text.value.scanned > 0 && text.value.unavailable.length === 0)
      out.push(ctx.evidence({ ...common, outcome: "pass", finding: `${owner} logged no secret-resolution errors in ${plural(text.value.scanned, "line")}.`, data: { scanned: text.value.scanned } }));
    else out.push(ctx.evidence({ ...common, outcome: "unknown", finding: `Whether ${owner} hit secret-resolution errors is unknown: its logs were ${text.value.scanned === 0 ? "empty" : "only partly readable"}.`, data: { scanned: text.value.scanned } }));
    return out;
  },
};

/* --------------------------------- identity --------------------------------- */

export const identityProbe: Probe = {
  id: "identity",
  hop: "identity",
  checks: ["identity.exists", "identity.access_denied"],
  async run(step, ctx) {
    const address = step.address;
    const out: Evidence[] = [];
    const got = await ctx.observe(address);
    if (!got.ok) out.push(ctx.unknown("identity", address, "identity.exists", got.message));
    else out.push(presenceEvidence(ctx, "identity", address, "identity.exists", got.value, "Workload identity"));

    const owner = step.owner;
    if (!owner) return out;
    const text = await ctx.text(owner);
    if (!text.ok) return [...out, ctx.unknown("identity", address, "identity.access_denied", text.message)];
    const hit = text.value.hits.find((h) => h.signature === "iam_denied");
    const common = { hop: "identity" as const, address, check: "identity.access_denied", simulated: text.value.simulated };
    if (hit)
      out.push(
        ctx.evidence({
          ...common,
          outcome: "fail",
          finding: `${owner} was denied access ${plural(hit.count, "time")}${hit.actions.length ? ` (${hit.actions.slice(0, 3).join(", ")})` : ""}.`,
          data: hitData(hit),
        })
      );
    else if (text.value.scanned > 0 && text.value.unavailable.length === 0)
      out.push(ctx.evidence({ ...common, outcome: "pass", finding: `${owner} logged no access-denied errors in ${plural(text.value.scanned, "line")}.`, data: { scanned: text.value.scanned } }));
    else out.push(ctx.evidence({ ...common, outcome: "unknown", finding: `Whether ${owner} was denied access is unknown: its logs were ${text.value.scanned === 0 ? "empty" : "only partly readable"}.`, data: { scanned: text.value.scanned } }));
    return out;
  },
};
