/**
 * Turn tofu's machine-readable UI stream (`plan -json`, `apply -json`) into
 * readable text plus structured diagnostics.
 *
 * Only `@message` and `diagnostic` fields are used. The stream's other fields
 * (planned/applied resource details, outputs) are ignored on purpose: the
 * plan itself comes from `show -json` and is masked by the normalizer, and
 * output values must never reach a log. Lines that are not JSON (a
 * truncation marker, a crash trace) are kept as plain text.
 */
import type { PlanDiagnostic } from "@/lib/tofu/plan";

export interface RenderedStream {
  text: string;
  diagnostics: PlanDiagnostic[];
}

interface UiDiagnostic {
  severity?: string;
  summary?: string;
  detail?: string;
}

export function renderUiStream(raw: string): RenderedStream {
  const lines: string[] = [];
  const diagnostics: PlanDiagnostic[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("{")) {
      try {
        const obj = JSON.parse(trimmed) as { "@message"?: unknown; type?: unknown; diagnostic?: UiDiagnostic };
        if (obj.type === "diagnostic" && obj.diagnostic && typeof obj.diagnostic.summary === "string") {
          const sev = obj.diagnostic.severity === "error" ? "error" : "warning";
          const d: PlanDiagnostic = { severity: sev, summary: obj.diagnostic.summary };
          if (typeof obj.diagnostic.detail === "string" && obj.diagnostic.detail) d.detail = obj.diagnostic.detail;
          diagnostics.push(d);
          lines.push(`${sev === "error" ? "Error" : "Warning"}: ${d.summary}${d.detail ? `\n${d.detail}` : ""}`);
          continue;
        }
        if (typeof obj["@message"] === "string") {
          lines.push(obj["@message"]);
          continue;
        }
      } catch {
        /* a JSON line cut by truncation: fall through and keep it as text */
      }
    }
    lines.push(trimmed);
  }
  return { text: lines.join("\n"), diagnostics };
}
