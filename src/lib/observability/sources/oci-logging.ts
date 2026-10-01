/**
 * OCI Logging Search over a runner session. One environment-owned log group
 * per query; user text is a local substring filter, never Logging Query Language.
 * Pages, jobs, bytes and messages are capped. Partial coverage is labeled.
 * Cloud text is redacted data, never instructions. Contract tests use production
 * runner tables with synthetic responses; no OCI tenancy was exercised live.
 * API shape: https://docs.oracle.com/en-us/iaas/tools/go/latest/loggingsearch/
 */
import { randomUUID } from "node:crypto";
import type { OciResourceBinding } from "@/lib/credentials/types";
import { isRecord, meetsMinSeverity, inferSeverity, sortNewestFirst, unavailableResult, emptyResult } from "../normalize";
import { sanitizeMessage } from "../redact";
import { validateLogQuery } from "../query";
import type { NormalizedLog, ObservabilitySource, QueryResult } from "../types";
import { boundResources, OCI_READ_BUDGET, readSignal, signalRequest, validTimestamp, type OciSignalSession } from "./oci-common";

export const OCI_LOGGING_SOURCE_ID = "oci.logging";

function logRecord(raw: unknown, resource: OciResourceBinding, session: OciSignalSession, environmentId: string): NormalizedLog | undefined {
  if (!isRecord(raw) || !isRecord(raw.data)) return undefined;
  const entry = raw.data;
  const content = isRecord(entry.logContent) ? entry.logContent : entry;
  const oracle = isRecord(content.oracle) ? content.oracle : {};
  if ((oracle.compartmentid !== undefined && oracle.compartmentid !== session.compartmentOcid) || (oracle.loggroupid !== undefined && oracle.loggroupid !== resource.externalId)) return undefined;
  const data = isRecord(content.data) ? content.data : content;
  const timestamp = validTimestamp(content.time ?? entry.datetime);
  const text = typeof data.message === "string" ? data.message : typeof content.data === "string" ? content.data : undefined;
  if (!timestamp || text === undefined) return undefined;
  const clean = sanitizeMessage(text);
  const level = typeof data.level === "string" ? data.level : typeof data.severity === "string" ? data.severity : undefined;
  const guess = level ? inferSeverity(JSON.stringify({ level })) : inferSeverity(clean.message);
  return { timestamp, address: resource.address, provider: "oci", environmentId, severity: guess.severity, message: clean.message,
    attributes: {}, native: { logGroupId: resource.externalId, untrusted: true, ...(guess.heuristic ? { severityHeuristic: level ? "provider" : guess.heuristic } : {}), ...(clean.redacted ? { redacted: true } : {}), ...(clean.truncated ? { messageTruncated: true } : {}) } };
}

export function createOciLoggingSource(session?: OciSignalSession): ObservabilitySource {
  return { id: OCI_LOGGING_SOURCE_ID, provider: "oci", supports: ["log"],
    async searchLogs(input, signal): Promise<QueryResult<NormalizedLog>> {
      const q = validateLogQuery(input, Date.now());
      signal.throwIfAborted();
      const unavailable = (reason: string) => unavailableResult<NormalizedLog>(OCI_LOGGING_SOURCE_ID, reason);
      if (!session) return unavailable("no OCI runner session: logs require a credential-broker observe session");
      const request = signalRequest(session, "loggingsearch", "/20190909/search");
      if (!request) return unavailable("OCI Logging Search service or capability allowlist is unavailable.");
      const resources = boundResources(session, q.scope);
      if (!resources) return unavailable("OCI environment resource bindings are unavailable for this scope.");
      const groups = resources.filter((r) => r.nativeType === "oci:log_group");
      if (!groups.length) return unavailable("No OCI log groups are bound to the selected environment resources.");
      const result = emptyResult<NormalizedLog>();
      let calls = 0;
      let malformed = false;
      const seen = new Set<string>();
      for (const group of groups) {
        let page: string | undefined;
        const pages = new Set<string>();
        do {
          if (calls >= OCI_READ_BUDGET || result.items.length >= q.limit) { result.truncated = true; break; }
          calls++;
          try {
            const response = await readSignal(session, { ...request, query: { limit: Math.min(1000, Math.max(q.limit, 200)), ...(page ? { page } : {}) }, headers: { "opc-retry-token": randomUUID() },
              body: { timeStart: q.range.from, timeEnd: q.range.to, searchQuery: `search "${session.compartmentOcid}/${group.externalId}" | sort by datetime desc`, isReturnFieldInfo: false } }, signal);
            if (!isRecord(response.body) || !Array.isArray(response.body.results) || response.body.results.length > 1000) throw new Error("OCI Logging Search returned a malformed page.");
            if (!result.sources.length) result.sources.push(OCI_LOGGING_SOURCE_ID);
            for (const raw of response.body.results) {
              const item = logRecord(raw, group, session, q.scope.environmentId);
              if (!item) { malformed = true; continue; }
              if (item.timestamp < q.range.from || item.timestamp > q.range.to || !meetsMinSeverity(item.severity, q.minSeverity) || (q.text !== undefined && !item.message.includes(q.text))) continue;
              const key = JSON.stringify([item.address, item.timestamp, item.message, isRecord(raw) && isRecord(raw.data) && isRecord(raw.data.logContent) ? raw.data.logContent.id : undefined]);
              if (seen.has(key)) continue;
              seen.add(key);
              if (result.items.length >= q.limit) { result.truncated = true; break; }
              result.items.push(item);
            }
            const next = response.headers["opc-next-page"];
            if (next !== undefined && (typeof next !== "string" || next.length > 2048 || /[\u0000-\u001f\u007f]/.test(next))) throw new Error("OCI Logging Search returned an invalid page token.");
            page = next || undefined;
            if (page && pages.has(page)) { result.truncated = true; result.notes = ["OCI Logging Search repeated a page token; remaining coverage is unknown."]; break; }
            if (page) pages.add(page);
            if (page && result.items.length >= q.limit) result.truncated = true;
          } catch {
            signal.throwIfAborted();
            result.unavailable.push({ source: OCI_LOGGING_SOURCE_ID, reason: "OCI Logging Search runner read failed or returned an unusable page." });
            break;
          }
        } while (page);
        if (calls >= OCI_READ_BUDGET || result.items.length >= q.limit) { if (page || group !== groups.at(-1)) result.truncated = true; break; }
      }
      if (malformed) { result.truncated = true; (result.notes ??= []).push("OCI Logging Search returned entries without usable log data or matching resource identity; those entries were omitted."); }
      if (result.truncated) (result.notes ??= []).push("OCI log coverage is bounded by the result limit and ten runner reads.");
      result.items = sortNewestFirst(result.items, (item) => item.timestamp);
      return result;
    },
  };
}
