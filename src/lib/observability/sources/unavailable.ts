/**
 * A source that exists so a missing prerequisite is REPORTED, not silent.
 *
 * `sourcesForEnvironment` uses it when an environment's provider needs a
 * session, endpoint or driver that was not supplied (or is not implemented
 * yet): every signal it supports answers with an `unavailable` entry naming
 * the source and the reason, instead of the query returning an unexplained
 * empty result.
 */
import { unavailableResult } from "../normalize";
import type { ObservabilitySource, SignalType } from "../types";

export function createUnavailableSource(opts: { id: string; provider: string; supports: SignalType[]; reason: string }): ObservabilitySource {
  const answer = <T>() => Promise.resolve(unavailableResult<T>(opts.id, opts.reason));
  const source: ObservabilitySource = { id: opts.id, provider: opts.provider, supports: opts.supports };
  if (opts.supports.includes("log")) source.searchLogs = () => answer();
  if (opts.supports.includes("metric")) source.queryMetrics = () => answer();
  if (opts.supports.includes("event")) source.searchEvents = () => answer();
  if (opts.supports.includes("trace")) source.searchTraces = () => answer();
  return source;
}
