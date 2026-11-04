/**
 * Sanitisers for values that end up in AWS session tags and role session
 * names. Inputs are Zenith ids (already constrained) but are treated as
 * untrusted here: the output is guaranteed to be within the STS charset and
 * length limits, so a surprising id can degrade a tag but never fail the call
 * or smuggle characters into it.
 */
import { TAG_CAPABILITY, TAG_OPERATION, TAG_WORKSPACE } from "./naming";

/** IAM tag charset (letters, digits, space and `_ . : / = + - @`); values may be up to 256 chars, keys 128. */
const DISALLOWED = /[^\p{L}\p{N} _.:/=+@-]/gu;

export function sanitizeTagValue(value: string, max = 256): string {
  const cleaned = String(value).replace(DISALLOWED, "_").trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : "unknown";
}

export function sanitizeTagKey(key: string, max = 128): string {
  let cleaned = String(key).replace(DISALLOWED, "_").trim().slice(0, max);
  if (/^aws:/i.test(cleaned)) cleaned = `zenith-${cleaned.slice(4)}`;
  return cleaned.length > 0 ? cleaned : "zenith:tag";
}

export interface SessionTagInput {
  workspaceId: string;
  operationId: string;
  capability: string;
}

/** The three session tags every brokered session carries (`Record` form for the OIDC claim). */
export function sessionTagRecord(input: SessionTagInput): Record<string, string> {
  return {
    [TAG_WORKSPACE]: sanitizeTagValue(input.workspaceId),
    [TAG_OPERATION]: sanitizeTagValue(input.operationId),
    [TAG_CAPABILITY]: sanitizeTagValue(input.capability),
  };
}

/** STS `Tags` parameter form. */
export function sessionTagList(input: SessionTagInput): { Key: string; Value: string }[] {
  return Object.entries(sessionTagRecord(input)).map(([Key, Value]) => ({ Key, Value }));
}

/** `zenith-<short op id>`: 2–64 chars from `[\w+=,.@-]`. */
export function roleSessionName(operationId: string): string {
  const short = String(operationId)
    .replace(/[^A-Za-z0-9_=,.@-]/g, "-")
    .slice(0, 24);
  return `zenith-${short.length > 0 ? short : "op"}`;
}
