/**
 * Canary secrets and the deep scanner that hunts for them (WS-SEC).
 *
 * A canary is a distinct, high-entropy, fake secret shaped like a real one
 * (AWS keys, JWTs, PEM private keys, passwords, Zenith agent tokens, …). A
 * security test plants canaries where a secret could legitimately be — a
 * sensitive plan attribute, an environment variable, a manifest value, a
 * provider response — drives the code under test, and then scans EVERYTHING that
 * crossed a trust boundary (return values, thrown errors, audit rows, events,
 * MCP results, plan views, logs) for any of them.
 *
 *     const pw = canarySecret("db-password");
 *     const hits = deepScanForCanaries(await callTool(...), [pw]);
 *     expectNoCanaries(hits, "MCP v1 tool results carry no secret values");
 *
 * Why the scanner also looks for ENCODED forms: a leak rarely arrives verbatim.
 * A serializer JSON-escapes a PEM's newlines, a URL builder percent-encodes a
 * password, a logger base64s an Authorization header, a debug dump hex-encodes a
 * key. `encodedForms()` produces the forms a canary takes in those cases
 * (including the three base64 alignments of a canary embedded in a larger
 * buffer) and the scanner looks for every one of them.
 *
 * Determinism: canaries are derived from `HMAC(seed, label|shape|counter)`.
 * The default seed is a constant, so a failing run is reproducible bit for bit
 * (a flaky redaction test would be worse than none: whether a random 40-character
 * key happens to contain a `/` decides whether a URL-userinfo regex catches it).
 * Set `ZENITH_SECURITY_CANARY_SEED` to explore other values. Two calls with the
 * same label and shape return DIFFERENT values (a counter is mixed in) so two
 * tests never accidentally share a secret; pass `{ stable: true }` to get the
 * value that depends on label and shape alone, which is what a coverage
 * measurement needs. Keep the returned string if you need it again.
 *
 * Honest limits: this proves absence of the planted values and their listed
 * encodings. It cannot prove absence of a secret the test never planted, of a
 * transformed secret (hashed, encrypted, split across fields) or of a
 * low-entropy secret a real system would recognise by context. Absence in a
 * test is evidence, not a guarantee.
 */
import { createHmac } from "node:crypto";

/* --------------------------------- shapes --------------------------------- */

export type CanaryShape =
  | "password"
  | "aws-access-key-id"
  | "aws-secret-access-key"
  | "aws-session-token"
  | "jwt"
  | "pem-private-key"
  | "zenith-agent-token"
  | "github-token"
  | "slack-token"
  | "hex-key";

export const CANARY_SHAPES: readonly CanaryShape[] = [
  "password",
  "aws-access-key-id",
  "aws-secret-access-key",
  "aws-session-token",
  "jwt",
  "pem-private-key",
  "zenith-agent-token",
  "github-token",
  "slack-token",
  "hex-key",
];

export interface CanaryRecord {
  label: string;
  shape: CanaryShape;
  /** the planted value */
  value: string;
  /**
   * Every fragment whose appearance alone counts as a leak: the value itself
   * plus, where the shape has natural sub-parts, those parts (each body line of
   * a PEM, the payload and signature of a JWT), so a redactor that removes only
   * the first line still fails the scan.
   */
  needles: string[];
}

const SEED = process.env.ZENITH_SECURITY_CANARY_SEED?.trim() || "zenith-security-canaries-v1";
let counter = 0;
const registry = new Map<string, CanaryRecord>();

function bytesFor(label: string, shape: CanaryShape, n: number, serial: number): Buffer {
  const out: Buffer[] = [];
  let have = 0;
  for (let block = 0; have < n; block++) {
    const chunk = createHmac("sha256", SEED).update(`${label}\0${shape}\0${serial}\0${block}`).digest();
    out.push(chunk);
    have += chunk.length;
  }
  return Buffer.concat(out).subarray(0, n);
}

function pick(bytes: Buffer, alphabet: string): string {
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

const UPPER_B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B64 = `${ALNUM}+/`;
const B64URL = `${ALNUM}-_`;
const PASSWORD_ALPHABET = `${ALNUM}!#%*-_.~`;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function build(label: string, shape: CanaryShape, serial: number): { value: string; needles: string[] } {
  const raw = (n: number) => bytesFor(label, shape, n, serial);
  const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40);
  switch (shape) {
    case "password": {
      // begins with a letter so it survives being placed in identifier-ish positions
      const value = `Pw${pick(raw(22), PASSWORD_ALPHABET)}`;
      return { value, needles: [value] };
    }
    case "aws-access-key-id": {
      const value = `AKIA${pick(raw(16), UPPER_B32)}`;
      return { value, needles: [value] };
    }
    case "aws-secret-access-key": {
      const value = pick(raw(40), B64);
      return { value, needles: [value] };
    }
    case "aws-session-token": {
      const value = `IQoJb3JpZ2luX2Vj${pick(raw(340), B64)}`;
      return { value, needles: [value, value.slice(16, 96)] };
    }
    case "jwt": {
      const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: `canary-${raw(4).toString("hex")}` }));
      const payload = b64url(
        JSON.stringify({ iss: "https://canary.invalid", sub: `canary:${safeLabel}`, jti: raw(12).toString("hex"), iat: 1790000000, exp: 1790000900 })
      );
      const signature = pick(raw(342), B64URL);
      const value = `${header}.${payload}.${signature}`;
      return { value, needles: [value, payload, signature] };
    }
    case "pem-private-key": {
      const body = pick(raw(1200), B64);
      const lines = body.match(/.{1,64}/g) ?? [];
      const value = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
      return { value, needles: [value, ...lines.filter((l) => l.length >= 32)] };
    }
    case "zenith-agent-token": {
      // the shape `security.ts` recognises: za_ + 43 base64url characters
      const value = `za_${pick(raw(43), B64URL)}`;
      return { value, needles: [value, value.slice(3)] };
    }
    case "github-token": {
      const value = `ghp_${pick(raw(36), ALNUM)}`;
      return { value, needles: [value, value.slice(4)] };
    }
    case "slack-token": {
      const value = `xoxb-${pick(raw(12), "0123456789")}-${pick(raw(24), ALNUM)}`;
      return { value, needles: [value] };
    }
    case "hex-key": {
      const value = raw(32).toString("hex");
      return { value, needles: [value] };
    }
  }
}

/**
 * A fresh canary secret. The value is a plain string so it can be dropped into
 * any fixture; `canaryRecord(value)` returns its label, shape and needles.
 */
export function canarySecret(label: string, shape: CanaryShape = "password", options: { stable?: boolean } = {}): string {
  const serial = options.stable ? 0 : ++counter;
  const { value, needles } = build(label, shape, serial);
  registry.set(value, { label, shape, value, needles });
  return value;
}

/** One canary of every shape, keyed by shape. */
export function canarySet(label: string): Record<CanaryShape, string> {
  const out = {} as Record<CanaryShape, string>;
  for (const shape of CANARY_SHAPES) out[shape] = canarySecret(`${label}/${shape}`, shape);
  return out;
}

export function canaryRecord(value: string): CanaryRecord | undefined {
  return registry.get(value);
}

/** Forget every registered canary (tests that assert on the registry itself). */
export function resetCanaries(): void {
  registry.clear();
  counter = 0;
}

/* --------------------------------- forms ---------------------------------- */

export interface EncodedForm {
  form: string;
  text: string;
}

const MIN_NEEDLE = 6;

function base64Alignments(s: string, urlSafe: boolean): string[] {
  const data = Buffer.from(s, "utf8");
  const out: string[] = [];
  const skips = [0, 2, 3];
  for (let k = 0; k < 3; k++) {
    const enc = Buffer.concat([Buffer.alloc(k, 0x41), data]).toString("base64");
    const rem = (k + data.length) % 3;
    const trailing = rem === 0 ? 0 : rem === 1 ? 3 : 2;
    let part = enc.slice(skips[k], enc.length - trailing);
    if (urlSafe) part = part.replace(/\+/g, "-").replace(/\//g, "_");
    if (part.length >= MIN_NEEDLE) out.push(part);
  }
  return out;
}

const jsonEscaped = (s: string) => JSON.stringify(s).slice(1, -1);
const unicodeEscaped = (s: string) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const percentAll = (s: string, upper: boolean) =>
  [...Buffer.from(s, "utf8")].map((b) => `%${upper ? b.toString(16).toUpperCase().padStart(2, "0") : b.toString(16).padStart(2, "0")}`).join("");

/**
 * The forms `needle` takes when a system re-encodes it. `raw` is always first.
 * Forms shorter than six characters are dropped (they would match by chance).
 */
export function encodedForms(needle: string): EncodedForm[] {
  const forms: EncodedForm[] = [{ form: "raw", text: needle }];
  const add = (form: string, text: string) => {
    if (text.length >= MIN_NEEDLE && !forms.some((f) => f.text === text)) forms.push({ form, text });
  };
  add("json-escaped", jsonEscaped(needle));
  add("json-escaped-slashes", jsonEscaped(needle).replace(/\//g, "\\/"));
  add("json-double-escaped", jsonEscaped(jsonEscaped(needle)));
  add("json-unicode-escaped", unicodeEscaped(needle));
  add("url-encoded", encodeURIComponent(needle));
  add("url-encoded-uri", encodeURI(needle));
  add("form-urlencoded", encodeURIComponent(needle).replace(/%20/g, "+"));
  add("url-double-encoded", encodeURIComponent(encodeURIComponent(needle)));
  add("percent-all-lower", percentAll(needle, false));
  add("percent-all-upper", percentAll(needle, true));
  add("hex-lower", Buffer.from(needle, "utf8").toString("hex"));
  add("hex-upper", Buffer.from(needle, "utf8").toString("hex").toUpperCase());
  base64Alignments(needle, false).forEach((t, i) => add(`base64@${i}`, t));
  base64Alignments(needle, true).forEach((t, i) => add(`base64url@${i}`, t));
  // a base64 of the canary that was itself JSON-escaped (`/` -> `\/`)
  for (const t of base64Alignments(needle, false)) add("base64-json-escaped", jsonEscaped(t).replace(/\//g, "\\/"));
  return forms;
}

/* --------------------------------- scanner -------------------------------- */

export interface CanaryHit {
  /** JSONPath-ish location, e.g. `$.resourceChanges[0].changes[2].after` */
  path: string;
  /** label the canary was created with (or `(unregistered)`) */
  label: string;
  shape: CanaryShape | "unknown";
  form: string;
  /** where in the structure: a string value, an object key, an error field, decoded bytes */
  where: "value" | "key" | "error" | "bytes";
  /** first characters of the matched needle, never the whole secret */
  preview: string;
}

export interface ScanOptions {
  /**
   * Also report any string containing a prefix or suffix of a needle at least
   * this long (catches a redactor that truncates a secret instead of removing
   * it). 0 disables. Default 0.
   */
  fragmentLength?: number;
  /** maximum nodes visited (cycle and blow-up guard). Default 250,000. */
  maxNodes?: number;
  /** label for the root in reported paths. Default `$`. */
  root?: string;
}

interface Needle {
  label: string;
  shape: CanaryShape | "unknown";
  needle: string;
  forms: EncodedForm[];
  fragments: string[];
}

function needlesOf(canaries: readonly string[], fragmentLength: number): Needle[] {
  const out: Needle[] = [];
  for (const c of canaries) {
    if (typeof c !== "string" || c.length < MIN_NEEDLE) throw new Error(`deepScanForCanaries: canary "${String(c).slice(0, 12)}…" is too short to scan for safely (min ${MIN_NEEDLE}).`);
    const rec = registry.get(c);
    const parts = rec?.needles ?? [c];
    for (const part of parts) {
      const fragments: string[] = [];
      if (fragmentLength > 0 && part.length > fragmentLength * 2) {
        fragments.push(part.slice(0, fragmentLength), part.slice(-fragmentLength));
      }
      out.push({ label: rec?.label ?? "(unregistered)", shape: rec?.shape ?? "unknown", needle: part, forms: encodedForms(part), fragments });
    }
  }
  return out;
}

function tryDecodeUri(s: string): string | undefined {
  if (!/%[0-9a-fA-F]{2}/.test(s)) return undefined;
  try {
    const decoded = decodeURIComponent(s);
    return decoded !== s ? decoded : undefined;
  } catch {
    return undefined;
  }
}

const isPlainKeyPath = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const at = (path: string, key: string | number) => (typeof key === "number" ? `${path}[${key}]` : isPlainKeyPath.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);

/**
 * Walk `value` (objects, arrays, strings, buffers, errors, maps, sets; keys as
 * well as values) and report every canary — in any of its encoded forms — that
 * appears in it. Returns `[]` when the value is clean.
 */
export function deepScanForCanaries(value: unknown, canaries: readonly string[], options: ScanOptions = {}): CanaryHit[] {
  const needles = needlesOf(canaries, options.fragmentLength ?? 0);
  const hits: CanaryHit[] = [];
  const seen = new WeakSet<object>();
  const budget = { left: options.maxNodes ?? 250_000 };
  const reported = new Set<string>();

  const report = (path: string, n: Needle, form: string, where: CanaryHit["where"]) => {
    const key = `${path}|${n.needle}|${form}|${where}`;
    if (reported.has(key)) return;
    reported.add(key);
    hits.push({ path, label: n.label, shape: n.shape, form, where, preview: `${n.needle.slice(0, 6)}…(${n.needle.length})` });
  };

  const scanText = (text: string, path: string, where: CanaryHit["where"], depth = 0) => {
    if (text.length < MIN_NEEDLE) return;
    for (const n of needles) {
      for (const f of n.forms) if (text.includes(f.text)) report(path, n, f.form, where);
      for (const frag of n.fragments) if (text.includes(frag)) report(path, n, "fragment", where);
    }
    if (depth < 2) {
      const decoded = tryDecodeUri(text);
      if (decoded) scanText(decoded, path, where, depth + 1);
    }
  };

  const walk = (v: unknown, path: string, depth: number): void => {
    if (budget.left-- <= 0 || depth > 64) return;
    if (typeof v === "string") return scanText(v, path, "value");
    if (typeof v === "number" || typeof v === "bigint") return scanText(String(v), path, "value");
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);

    if (v instanceof ArrayBuffer) return scanText(Buffer.from(v).toString("latin1"), path, "bytes");
    if (ArrayBuffer.isView(v)) return scanText(Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("latin1"), path, "bytes");

    if (v instanceof Error) {
      scanText(`${v.name}: ${v.message}`, path, "error");
      if (v.stack) scanText(v.stack, `${path}.stack`, "error");
      if ("cause" in v) walk((v as { cause?: unknown }).cause, `${path}.cause`, depth + 1);
      for (const k of Object.keys(v)) walk((v as unknown as Record<string, unknown>)[k], at(path, k), depth + 1);
      return;
    }
    if (v instanceof Map) {
      let i = 0;
      for (const [k, val] of v) {
        walk(k, `${path}.<mapkey#${i}>`, depth + 1);
        walk(val, `${path}.<map#${i}>`, depth + 1);
        i++;
      }
      return;
    }
    if (v instanceof Set) {
      let i = 0;
      for (const val of v) walk(val, `${path}.<set#${i++}>`, depth + 1);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, at(path, i), depth + 1));
      return;
    }
    const withJson = v as { toJSON?: () => unknown };
    if (typeof withJson.toJSON === "function") {
      let projected: unknown;
      try {
        projected = withJson.toJSON();
      } catch {
        projected = undefined;
      }
      if (projected !== v) return walk(projected, path, depth + 1);
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      scanText(k, at(path, k), "key");
      walk(val, at(path, k), depth + 1);
    }
  };

  walk(value, options.root ?? "$", 0);
  return hits;
}

/** A readable, secret-free description of hits for an assertion message. */
export function formatCanaryHits(hits: readonly CanaryHit[]): string {
  return hits.map((h) => `  - canary "${h.label}" (${h.shape}) found as ${h.form} in ${h.where} at ${h.path} [${h.preview}]`).join("\n");
}

/**
 * Throw, naming the invariant, when the scan found anything. `invariant` is the
 * sentence a maintainer should read first: what property this test protects.
 */
export function expectNoCanaries(hits: readonly CanaryHit[], invariant: string): void {
  if (hits.length === 0) return;
  throw new Error(`SECURITY INVARIANT VIOLATED: ${invariant}\n${hits.length} planted secret(s) reached a surface that must never carry them:\n${formatCanaryHits(hits)}`);
}

/** `deepScanForCanaries` + `expectNoCanaries` in one call. */
export function assertNoCanaries(value: unknown, canaries: readonly string[], invariant: string, options?: ScanOptions): void {
  expectNoCanaries(deepScanForCanaries(value, canaries, options), invariant);
}
