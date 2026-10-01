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
import { redactOutput } from "@/lib/tofu/redact";

export const redactText = (text: string): string => redactCredentials(redactOutput(text));
