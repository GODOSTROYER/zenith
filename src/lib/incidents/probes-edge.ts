/**
 * Edge probes: DNS, TLS, load balancer, firewall rules, and the optional
 * end-to-end HTTP probe. All read-only; every outcome is derived from what a
 * port actually returned.
 *
 *   dns.record_present / dns.record_target
 *   tls.certificate_issued / tls.certificate_expiry      (warn below 14 days)
 *   lb.listeners_present / lb.target_health / lb.http_5xx
 *   firewall.ingress_rule                                (the exact rule, when missing)
 *   http.dns_resolution / http.tls_handshake / http.endpoint
 *
 * What each check does NOT claim: a `pass` means "nothing wrong was found in
 * what was read", and the finding says what was read. An attribute nobody read
 * is never treated as matching (`unknown`), a denied read is `unknown`, and a
 * port that throws or times out is `unknown`. Provider-specific attribute names
 * are accepted in a few common spellings (`status`/`state`, `notAfter`/
 * `expiresAt`, `listeners`/`listenerPorts`); a driver that uses others yields
 * `unknown`, not a guess.
 */
import type { FirewallSpec, LoadBalancerSpec } from "@/lib/resources/specs";
import type { Observation } from "@/lib/resources/types";
import { compareExpected, known, num, parseSignals, plural, round, summarizeSeries } from "./probe-util";
import type { GlobalProbe, Probe } from "./probe-types";
import type { ProbeContext } from "./probe-context";
import { sanitizeText } from "./sanitize";
import type { PathStep, RequestPath } from "./traverse";
import type { Evidence, Hop } from "./types";

const DAY_MS = 86_400_000;
export const CERT_EXPIRY_WARN_DAYS = 14;

/** `unknown` evidence for a presence the provider could not establish (denied, errored). */
function unreadable(ctx: ProbeContext, hop: Hop, address: string, check: string, o: Observation, what: string): Evidence {
  const why = o.presence === "inaccessible" ? "access to read it was denied" : "the provider did not say";
  return ctx.evidence({
    hop,
    address,
    check,
    outcome: "unknown",
    finding: `${what} could not be read (${why})${o.error ? `: ${sanitizeText(o.error, 160)}` : ""}.`,
    data: { presence: o.presence },
    simulated: o.simulated,
    source: o.source,
    observedAt: o.observedAt,
  });
}

const allUnknown = (checks: readonly string[], ctx: ProbeContext, hop: Hop, address: string, message: string): Evidence[] =>
  checks.map((c) => ctx.unknown(hop, address, c, message));

/* ----------------------------------- DNS ------------------------------------ */

const DNS_TARGET_KEYS: ReadonlySet<string> = new Set(["target", "value", "values", "alias", "aliasTarget", "alias_target", "records", "dnsName", "cname"]);

export const dnsProbe: Probe = {
  id: "dns",
  hop: "dns",
  checks: ["dns.record_present", "dns.record_target"],
  async run(step, ctx) {
    const address = step.address;
    const name = String((ctx.node(address)?.spec as { name?: string } | undefined)?.name ?? address);
    const got = await ctx.observe(address);
    if (!got.ok) return allUnknown(dnsProbe.checks, ctx, "dns", address, got.message);
    const o = got.value;
    const common = { hop: "dns" as const, address, simulated: o.simulated, source: o.source, observedAt: o.observedAt };
    if (o.presence === "missing")
      return [ctx.evidence({ ...common, check: "dns.record_present", outcome: "fail", finding: `DNS record ${name} is not present in the zone.`, data: { presence: "missing", name } })];
    if (o.presence !== "present") return [unreadable(ctx, "dns", address, "dns.record_present", o, `DNS record ${name}`)];

    const out = [ctx.evidence({ ...common, check: "dns.record_present", outcome: "pass", finding: `DNS record ${name} is present.`, data: { presence: "present", name } })];
    const exp = await ctx.expected(address);
    if (!exp.ok) return [...out, ctx.unknown("dns", address, "dns.record_target", exp.message)];
    const cmp = compareExpected(exp.value, o, DNS_TARGET_KEYS);
    if (cmp.diffs.length > 0) {
      const d = cmp.diffs[0];
      out.push(
        ctx.evidence({
          ...common,
          check: "dns.record_target",
          outcome: "fail",
          finding: `DNS record ${name} does not point where the desired graph says: ${d.attribute} is ${JSON.stringify(d.observed)} but ${JSON.stringify(d.desired)} was expected.`,
          data: { name, diffs: cmp.diffs.slice(0, 5) },
        })
      );
    } else if (cmp.compared > 0) {
      out.push(ctx.evidence({ ...common, check: "dns.record_target", outcome: "pass", finding: `DNS record ${name} points where the desired graph says (${plural(cmp.compared, "attribute")} compared).`, data: { name, compared: cmp.compared } }));
    } else {
      out.push(ctx.evidence({ ...common, check: "dns.record_target", outcome: "unknown", finding: `DNS record ${name} exists, but its target was not read, so where it points is unverified.`, data: { name, unread: cmp.unread.slice(0, 8) } }));
    }
    return out;
  },
};

/* ----------------------------------- TLS ------------------------------------ */

const OK_CERT = new Set(["issued", "active", "ready", "valid", "true"]);

export const tlsProbe: Probe = {
  id: "tls",
  hop: "tls",
  checks: ["tls.certificate_issued", "tls.certificate_expiry"],
  async run(step, ctx) {
    const address = step.address;
    const domain = String((ctx.node(address)?.spec as { domain?: string } | undefined)?.domain ?? address);
    const got = await ctx.observe(address);
    if (!got.ok) return allUnknown(tlsProbe.checks, ctx, "tls", address, got.message);
    const o = got.value;
    const common = { hop: "tls" as const, address, simulated: o.simulated, source: o.source, observedAt: o.observedAt };
    if (o.presence === "missing")
      return [ctx.evidence({ ...common, check: "tls.certificate_issued", outcome: "fail", finding: `The certificate for ${domain} does not exist at the provider.`, data: { presence: "missing", domain } })];
    if (o.presence !== "present") return [unreadable(ctx, "tls", address, "tls.certificate_issued", o, `The certificate for ${domain}`)];

    const out: Evidence[] = [];
    const status = known(o, "status", "state");
    if (!status) {
      out.push(ctx.evidence({ ...common, check: "tls.certificate_issued", outcome: "unknown", finding: `The certificate for ${domain} exists, but its status was not read.`, data: { domain } }));
    } else {
      const s = String(status.value).toLowerCase().replace(/[_\s]+/g, "-");
      const ok = OK_CERT.has(s);
      out.push(
        ctx.evidence({
          ...common,
          check: "tls.certificate_issued",
          outcome: ok ? "pass" : "fail",
          finding: ok ? `The certificate for ${domain} is issued.` : `The certificate for ${domain} is not issued: its status is ${JSON.stringify(sanitizeText(status.value, 60))}.`,
          data: { domain, status: sanitizeText(status.value, 60), validation: (ctx.node(address)?.spec as { validation?: string } | undefined)?.validation ?? null },
        })
      );
    }

    const exp = known(o, "notAfter", "expiresAt", "not_after", "expiry");
    const at = exp ? Date.parse(String(exp.value)) : NaN;
    if (!exp || Number.isNaN(at)) {
      out.push(ctx.evidence({ ...common, check: "tls.certificate_expiry", outcome: "unknown", finding: `The expiry of the certificate for ${domain} was not read.`, data: { domain } }));
    } else {
      const days = (at - ctx.nowMs) / DAY_MS;
      const bad = days < CERT_EXPIRY_WARN_DAYS;
      out.push(
        ctx.evidence({
          ...common,
          check: "tls.certificate_expiry",
          outcome: bad ? "fail" : "pass",
          finding:
            days < 0
              ? `The certificate for ${domain} expired ${round(-days)} days ago.`
              : bad
                ? `The certificate for ${domain} expires in ${round(days)} days (warning threshold ${CERT_EXPIRY_WARN_DAYS}).`
                : `The certificate for ${domain} is valid for ${Math.floor(days)} more days.`,
          data: { domain, notAfter: new Date(at).toISOString(), daysRemaining: round(days), expired: days < 0 },
        })
      );
    }
    return out;
  },
};

/* ------------------------------- load balancer ------------------------------ */

function listenerPorts(value: unknown): Set<number> | undefined {
  if (!Array.isArray(value)) return undefined;
  const ports = new Set<number>();
  for (const v of value) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : typeof v === "object" && v !== null ? Number((v as { port?: unknown }).port) : NaN;
    if (Number.isInteger(n)) ports.add(n);
  }
  return ports;
}

export const lbProbe: Probe = {
  id: "load_balancer",
  hop: "load_balancer",
  checks: ["lb.listeners_present", "lb.target_health", "lb.http_5xx"],
  async run(step, ctx) {
    const address = step.address;
    const desired = ((ctx.node(address)?.spec as Partial<LoadBalancerSpec> | undefined)?.listeners ?? []).map((l) => l.port);
    const out: Evidence[] = [];

    const got = await ctx.observe(address);
    if (!got.ok) out.push(ctx.unknown("load_balancer", address, "lb.listeners_present", got.message));
    else {
      const o = got.value;
      const common = { hop: "load_balancer" as const, address, simulated: o.simulated, source: o.source, observedAt: o.observedAt };
      if (o.presence === "missing") out.push(ctx.evidence({ ...common, check: "lb.listeners_present", outcome: "fail", finding: `The load balancer ${address} does not exist at the provider, so it has no listeners.`, data: { presence: "missing", desired } }));
      else if (o.presence !== "present") out.push(unreadable(ctx, "load_balancer", address, "lb.listeners_present", o, `The load balancer ${address}`));
      else {
        const seen = known(o, "listeners", "listenerPorts", "listener_ports");
        const ports = seen ? listenerPorts(seen.value) : undefined;
        if (!ports) out.push(ctx.evidence({ ...common, check: "lb.listeners_present", outcome: "unknown", finding: `The load balancer ${address} exists, but its listeners were not read.`, data: { desired } }));
        else {
          const missing = desired.filter((p) => !ports.has(p));
          out.push(
            ctx.evidence({
              ...common,
              check: "lb.listeners_present",
              outcome: missing.length ? "fail" : "pass",
              finding: missing.length ? `The load balancer ${address} is missing listener${missing.length > 1 ? "s" : ""} on ${missing.map((p) => `tcp/${p}`).join(", ")}.` : `The load balancer ${address} has all ${desired.length} desired listeners.`,
              data: { desired, observed: [...ports].sort((a, b) => a - b), missing },
            })
          );
        }
      }
    }

    // target health: the runtime view of the load balancer's target groups
    const rt = await ctx.runtime(address);
    if (!rt.ok) out.push(ctx.unknown("load_balancer", address, "lb.target_health", rt.message));
    else {
      const r = rt.value;
      const sig = parseSignals(r);
      const healthy = num(r.counts, "targets_healthy");
      const unhealthy = sig.targetUnhealthy ?? num(r.counts, "targets_unhealthy");
      const common = { hop: "load_balancer" as const, address, simulated: r.simulated, source: r.source, observedAt: r.observedAt };
      const reasons = sig.reasons.slice(0, 6);
      if (r.health === "unknown" || (healthy === undefined && unhealthy === undefined && r.health === "healthy")) {
        out.push(ctx.evidence({ ...common, check: "lb.target_health", outcome: "unknown", finding: `The health of the targets behind ${address} was not read${sig.readFailed ? ` (${sanitizeText(sig.readFailed, 40)})` : ""}.`, data: { health: r.health, signals: sig.all.slice(0, 8) } }));
      } else if ((unhealthy ?? 0) > 0 || r.health === "unhealthy" || r.health === "degraded") {
        const total = (healthy ?? 0) + (unhealthy ?? 0);
        const noHealthy = healthy === 0 || (healthy === undefined && r.health === "unhealthy");
        const counted = (unhealthy ?? 0) > 0;
        out.push(
          ctx.evidence({
            ...common,
            check: "lb.target_health",
            outcome: "fail",
            finding: noHealthy
              ? `No healthy targets behind ${address}${unhealthy !== undefined ? ` (${unhealthy} unhealthy)` : ""}.`
              : counted
                ? `${unhealthy} of ${total} targets behind ${address} are unhealthy.`
                : `${address} reports ${r.health} health, although no unhealthy target was counted.`,
            data: { health: r.health, healthy: healthy ?? null, unhealthy: unhealthy ?? null, noHealthy, reasons },
          })
        );
      } else {
        out.push(ctx.evidence({ ...common, check: "lb.target_health", outcome: "pass", finding: `All ${healthy ?? "registered"} targets behind ${address} are healthy.`, data: { health: r.health, healthy: healthy ?? null, unhealthy: unhealthy ?? 0 } }));
      }
    }

    // 5xx from the load balancer's own metrics: a burst, not a blip
    const m = await ctx.metrics(address, ["http.5xx.rate"]);
    if (!m.ok) out.push(ctx.unknown("load_balancer", address, "lb.http_5xx", m.message));
    else {
      const series = m.value.series.find((s) => s.metric === "http.5xx.rate");
      const sum = series ? summarizeSeries(series) : undefined;
      const common = { hop: "load_balancer" as const, address, simulated: m.value.simulated };
      if (!sum) out.push(ctx.evidence({ ...common, check: "lb.http_5xx", outcome: "unknown", finding: `No http.5xx.rate samples were returned for ${address}.`, data: { unavailable: m.value.unavailable.slice(0, 3) } }));
      else {
        const burst = sum.nonZero >= 2;
        out.push(
          ctx.evidence({
            ...common,
            check: "lb.http_5xx",
            outcome: burst ? "fail" : "pass",
            finding: burst ? `${address} served 5xx responses in ${sum.nonZero} of ${sum.points} recent samples (peak ${round(sum.peak, 2)} ${sum.unit}).` : `${address} shows no sustained 5xx responses (${sum.nonZero} of ${sum.points} samples non-zero).`,
            data: { samples: sum.points, nonZero: sum.nonZero, peak: round(sum.peak, 2), unit: sum.unit },
          })
        );
      }
    }
    return out;
  },
};

/* --------------------------------- firewall --------------------------------- */

const ruleText = (r: NonNullable<PathStep["rule"]>): string => `tcp/${r.port} from ${"address" in r.source ? r.source.address : r.source.cidr} to ${r.target}`;

export const firewallProbe: Probe = {
  id: "firewall",
  hop: "firewall",
  checks: ["firewall.ingress_rule"],
  async run(step, ctx) {
    const address = step.address;
    const spec = ctx.node(address)?.spec as Partial<FirewallSpec> | undefined;
    const rule = step.rule;
    if (!rule) return [ctx.unknown("firewall", address, "firewall.ingress_rule", "the graph node has no readable rule spec")];
    const what = `Ingress rule ${ruleText(rule)} (${address}${spec?.capability ? `, capability ${sanitizeText(spec.capability, 40)}` : ""})`;
    const ruleData = { source: rule.source, target: rule.target, port: rule.port, protocol: "tcp", capability: rule.capability };
    const meta = { protects: step.dependency?.class ?? ("cidr" in rule.source ? "internet" : "service"), dependency: step.dependency?.address ?? rule.target, client: step.dependency?.client ?? ("address" in rule.source ? rule.source.address : null) };

    const got = await ctx.observe(address);
    if (!got.ok) return [ctx.unknown("firewall", address, "firewall.ingress_rule", got.message, { rule: ruleData, ...meta })];
    const o = got.value;
    const common = { hop: "firewall" as const, address, simulated: o.simulated, source: o.source, observedAt: o.observedAt };
    if (o.presence === "missing")
      return [ctx.evidence({ ...common, check: "firewall.ingress_rule", outcome: "fail", finding: `${what} is not present in the provider's configuration.`, data: { presence: "missing", rule: ruleData, ...meta } })];
    if (o.presence !== "present") return [unreadable(ctx, "firewall", address, "firewall.ingress_rule", o, what)];

    const exp = await ctx.expected(address);
    if (exp.ok) {
      const cmp = compareExpected(exp.value, o);
      if (cmp.diffs.length > 0)
        return [
          ctx.evidence({
            ...common,
            check: "firewall.ingress_rule",
            outcome: "fail",
            finding: `${what} exists but differs from the desired graph on ${cmp.diffs.map((d) => d.attribute).join(", ")}.`,
            data: { presence: "present", rule: ruleData, diffs: cmp.diffs.slice(0, 6), ...meta },
          }),
        ];
      if (cmp.compared > 0)
        return [ctx.evidence({ ...common, check: "firewall.ingress_rule", outcome: "pass", finding: `${what} is present and matches the desired graph (${plural(cmp.compared, "attribute")} compared).`, data: { presence: "present", rule: ruleData, compared: cmp.compared, ...meta } })];
    }
    return [
      ctx.evidence({
        ...common,
        check: "firewall.ingress_rule",
        outcome: "pass",
        finding: `${what} is present; its attributes were not read, so only its existence is established.`,
        data: { presence: "present", rule: ruleData, compared: 0, ...(exp.ok ? {} : { expectedUnavailable: true }), ...meta },
      }),
    ];
  },
};

/* ------------------------------ end-to-end HTTP ----------------------------- */

const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const DNS_ERR = /ENOTFOUND|EAI_AGAIN|EAI_NONAME|NXDOMAIN|getaddrinfo|name or service not known/i;
const TLS_ERR = /CERT_HAS_EXPIRED|certificate has expired|unable to verify|self[- ]signed|ALTNAME_INVALID|SSL|TLS|x509|certificate/i;
const MAX_PROBED_HOSTS = 3;

/**
 * One safe GET per public host, executed by the caller's prober (never by this
 * engine). The error text decides which hop the failure belongs to: a name
 * that does not resolve is DNS, a certificate problem is TLS, anything else
 * (refused, timed out, reset, 5xx) is the endpoint. A 4xx means "something
 * answered", which is reachability, not an outage.
 */
export const httpProbe: GlobalProbe = {
  id: "http",
  hop: "load_balancer",
  checks: ["http.endpoint"],
  async run(ctx: ProbeContext, path: RequestPath): Promise<Evidence[]> {
    if (!ctx.ports.httpProbe) return [];
    const probe = ctx.ports.httpProbe.bind(ctx.ports);
    const dnsSteps = path.steps.filter((s) => s.hop === "dns");
    const lb = path.steps.find((s) => s.hop === "load_balancer");
    const hosts = dnsSteps
      .map((s) => ({ step: s, name: String((ctx.node(s.address)?.spec as { name?: string } | undefined)?.name ?? "").toLowerCase() }))
      .filter((h) => HOST.test(h.name))
      .slice(0, MAX_PROBED_HOSTS);
    const out: Evidence[] = [];
    for (const { step, name } of hosts) {
      const tls = path.steps.find((s) => s.hop === "tls" && String((ctx.node(s.address)?.spec as { domain?: string } | undefined)?.domain ?? "").toLowerCase() === name);
      const url = `${tls ? "https" : "http"}://${name}/`;
      const r = await (async () => {
        const c = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            probe(url, { signal: c.signal }).then((v) => ({ ok: true as const, v })),
            new Promise<{ ok: false; message: string }>((res) => {
              timer = setTimeout(() => {
                c.abort();
                res({ ok: false, message: `probe of ${name} did not answer within ${ctx.config.probeTimeoutMs} ms` });
              }, ctx.config.probeTimeoutMs);
            }),
          ]);
        } catch (e) {
          return { ok: false as const, message: `probe of ${name} failed: ${sanitizeText(e instanceof Error ? e.message : String(e), 120)}` };
        } finally {
          if (timer) clearTimeout(timer);
        }
      })();
      const endpointAddress = lb?.address ?? step.address;
      if (!r.ok) {
        out.push(ctx.unknown("load_balancer", endpointAddress, "http.endpoint", r.message, { host: name, url }, name));
        continue;
      }
      const { status, latencyMs, error } = r.v;
      const base = { host: name, url, status: status ?? null, latencyMs: typeof latencyMs === "number" ? round(latencyMs, 0) : null };
      if (error) {
        const text = sanitizeText(error, 160);
        if (DNS_ERR.test(error)) out.push(ctx.evidence({ hop: "dns", address: step.address, key: name, check: "http.dns_resolution", outcome: "fail", finding: `${name} did not resolve when probed: ${text}`, data: { ...base, error: text } }));
        else if (TLS_ERR.test(error)) out.push(ctx.evidence({ hop: "tls", address: tls?.address ?? step.address, key: name, check: "http.tls_handshake", outcome: "fail", finding: `The TLS handshake to ${name} failed: ${text}`, data: { ...base, error: text } }));
        else out.push(ctx.evidence({ hop: "load_balancer", address: endpointAddress, key: name, check: "http.endpoint", outcome: "fail", finding: `${url} could not be reached: ${text}`, data: { ...base, error: text } }));
        continue;
      }
      if (typeof status !== "number") {
        out.push(ctx.unknown("load_balancer", endpointAddress, "http.endpoint", `the prober returned neither a status nor an error for ${name}`, base, name));
        continue;
      }
      out.push(ctx.evidence({ hop: "dns", address: step.address, key: name, check: "http.dns_resolution", outcome: "pass", finding: `${name} resolved and answered.`, data: base }));
      if (tls) out.push(ctx.evidence({ hop: "tls", address: tls.address, key: name, check: "http.tls_handshake", outcome: "pass", finding: `The TLS handshake to ${name} succeeded.`, data: base }));
      out.push(
        ctx.evidence({
          hop: "load_balancer",
          address: endpointAddress,
          key: name,
          check: "http.endpoint",
          outcome: status >= 500 ? "fail" : "pass",
          finding: `${url} answered HTTP ${status}.`,
          data: base,
        })
      );
    }
    return out;
  },
};
