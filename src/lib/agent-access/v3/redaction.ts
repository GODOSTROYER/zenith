/**
 * Every MCP v3 value a model can read passes through the shared model-visible
 * sanitizer (`src/lib/security/result-sanitizer.ts`): credential shapes in values,
 * secret-named members and secret-shaped member names are replaced by explicit
 * `[REDACTED:<kind>]` markers. The sanitizer is best-effort and never claims a
 * result is secret-free; `scrubWithReport` exposes its report so envelopes can say
 * when something was replaced.
 */
import { sanitizeForModel, type SanitizeReport } from "@/lib/security/result-sanitizer";

export function scrubMcpValue<T>(value: T): T {
  return sanitizeForModel(value).value;
}

export interface ScrubCollector {
  scrub<T>(value: T): T;
  /** merged report of everything scrubbed through this collector */
  report(): SanitizeReport;
}

export function scrubCollector(): ScrubCollector {
  const reports: SanitizeReport[] = [];
  return {
    scrub<T>(value: T): T {
      const r = sanitizeForModel(value);
      reports.push(r.report);
      return r.value;
    },
    report(): SanitizeReport {
      const kinds = new Set<string>();
      const paths: string[] = [];
      for (const r of reports) {
        for (const k of r.kinds) kinds.add(k);
        for (const p of r.paths) if (paths.length < 20 && !paths.includes(p)) paths.push(p);
      }
      return {
        applied: true,
        redactions: reports.reduce((n, r) => n + r.redactions, 0),
        kinds: [...kinds].sort(),
        paths,
        scanLimited: reports.some((r) => r.scanLimited),
        completeness: "best_effort",
      };
    },
  };
}
