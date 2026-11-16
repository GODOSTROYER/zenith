/**
 * Platform-configured Prometheus/Loki endpoints (PROD-OBS-02).
 *
 * The default observability stack reads these from the validated environment
 * (`ZENITH_OBSERVE_*`, see `src/lib/env.ts`), so the real MCP/incident/verify
 * callers of `sourcesForEnvironment` get metric and log backends without each
 * caller threading endpoints. The URLs are operator configuration; tenants can
 * never supply them. A malformed value becomes an explicit `unavailable`
 * source naming the variable, never a silent drop and never a throw that takes
 * the whole read down. Tokens are read per request and never appear in output.
 */
import { env } from "@/lib/env";
import { normalizeBaseUrl } from "./http";
import type { SourceEndpoints } from "./factory";
import { createUnavailableSource } from "./unavailable";
import type { ObservabilitySource } from "../types";
import type { ProviderKey } from "@/lib/resources/types";

export interface ConfiguredEndpoints {
  endpoints: SourceEndpoints;
  /** one unavailable source per configured-but-invalid backend */
  invalid: (provider: ProviderKey) => ObservabilitySource[];
}

function tokenOf(name: "ZENITH_OBSERVE_PROMETHEUS_TOKEN" | "ZENITH_OBSERVE_LOKI_TOKEN") {
  // read at call time so rotation needs no restart; the value never leaves this closure
  return () => {
    const v = process.env[name];
    return v && v.trim() ? v.trim() : undefined;
  };
}

export function configuredEndpoints(): ConfiguredEndpoints {
  const e = env();
  const endpoints: SourceEndpoints = {};
  const problems: { id: string; variable: string; reason: string }[] = [];
  const check = (url: string | undefined, variable: string, id: string): string | undefined => {
    if (!url) return undefined;
    try {
      return normalizeBaseUrl(url);
    } catch (error) {
      problems.push({ id, variable, reason: error instanceof Error ? error.message : "invalid" });
      return undefined;
    }
  };
  const prom = check(e.ZENITH_OBSERVE_PROMETHEUS_URL, "ZENITH_OBSERVE_PROMETHEUS_URL", "prometheus");
  if (prom) endpoints.prometheus = { baseUrl: prom, ...(e.ZENITH_OBSERVE_PROMETHEUS_TOKEN ? { tokenProvider: tokenOf("ZENITH_OBSERVE_PROMETHEUS_TOKEN") } : {}) };
  const loki = check(e.ZENITH_OBSERVE_LOKI_URL, "ZENITH_OBSERVE_LOKI_URL", "loki");
  if (loki) {
    endpoints.loki = {
      baseUrl: loki,
      ...(e.ZENITH_OBSERVE_LOKI_TOKEN ? { tokenProvider: tokenOf("ZENITH_OBSERVE_LOKI_TOKEN") } : {}),
      ...(e.ZENITH_OBSERVE_LOKI_TENANT ? { headers: { "X-Scope-OrgID": e.ZENITH_OBSERVE_LOKI_TENANT } } : {}),
    };
  }
  return {
    endpoints,
    invalid: (provider) =>
      problems.map((p) =>
        createUnavailableSource({
          id: p.id,
          provider,
          supports: p.id === "loki" ? ["log"] : ["metric"],
          reason: `${p.variable} is not a usable endpoint: ${p.reason}`,
        })
      ),
  };
}
