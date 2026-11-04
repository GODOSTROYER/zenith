/**
 * Redaction applied by the control plane to text an agent sends (log lines,
 * error strings) before it is stored. The agent already redacts (spec section 4);
 * this is the second, independent layer: the credential module's patterns
 * (AWS keys, session tokens, JWTs, bearer tokens, PEM blocks, `zrt_`/`za_`
 * tokens) plus the tofu engine's (URL userinfo, `secret = value` assignments).
 *
 * Defence in depth, never the mechanism: a secret in an unrecognisable shape
 * passes. The mechanism is that credentials never reach a job in the first place.
 */
import { redactCredentials } from "@/lib/credentials/redact";
import { sanitizeText } from "@/lib/security/result-sanitizer";
import { redactOutput } from "@/lib/tofu/redact";

/** Legacy patterns first, then the shared structured sanitizer (explicit markers; best-effort). */
export const redactText = (text: string): string => sanitizeText(redactCredentials(redactOutput(text))).text;
