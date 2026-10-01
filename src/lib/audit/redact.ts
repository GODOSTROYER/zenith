/**
 * Audit text is a bounded diagnostic, never a credential transport. Remove
 * exact secret-labelled input values as well as recognizable credential shapes
 * before applying the text budget. Opaque unlabelled prose cannot be inferred
 * to be secret; actions accepting source blobs must omit their diagnostics.
 */
import { redactCredentials } from "@/lib/credentials/redact";
import { sanitizeMessage } from "@/lib/observability/redact";

const SECRET_FIELD = /secret|password|passwd|token|credential|apikey|api_key|accesskey/i;
const SECRET_VAR_NAME = /key|secret|token|password|passwd|credential/i;

export function redactAuditText(text: string, input: unknown): string {
  const secrets = new Set<string>();
  const seen = new WeakSet<object>();
  let nodes = 0;
  const collect = (value: unknown, sensitive = false, depth = 0): void => {
    if (++nodes > 5_000 || depth > 20) return;
    if (typeof value === "string") {
      if (sensitive && value) secrets.add(value);
      return;
    }
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const secretPair = typeof record.key === "string" && SECRET_VAR_NAME.test(record.key);
    for (const [key, child] of Object.entries(record)) {
      collect(child, sensitive || SECRET_FIELD.test(key) || (secretPair && key === "value"), depth + 1);
    }
  };
  collect(input);
  let clean = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) clean = clean.split(secret).join("[REDACTED]");
  return sanitizeMessage(redactCredentials(clean)).message;
}
