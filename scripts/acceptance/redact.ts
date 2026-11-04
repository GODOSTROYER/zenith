/** Canonical credential redaction plus exact known integration-token removal.
 * JSON-escaped matching handles tokens containing quotes without corrupting data. */
import { redactDeep } from "@/lib/credentials/redact";
export function redactAcceptance<T>(value: T, secrets: readonly string[] = []): T {
  const safe = redactDeep(value);
  let encoded = JSON.stringify(safe);
  if (encoded === undefined) return safe;
  for (const secret of secrets) if (secret) encoded = encoded.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED TOKEN]");
  return JSON.parse(encoded) as T;
}
