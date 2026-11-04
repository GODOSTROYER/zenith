/**
 * Runtime sanity probes for the security suite (WS-SEC).
 *
 * Some security properties are only as good as the JavaScript engine under
 * them. `jsonParseKeyBug()` detects the V8 defect behind nodejs/node#60606:
 * introduced in V8 12.8.367, present in V8 13.6 (Node 24.x up to at least
 * 24.19.0, which is the version on this development machine) and V8 14.6
 * (Node 26). After a `JSON.parse` has created a map transition for a key that
 * ends in a backslash, a later parse can read another single-character key — an
 * escaped one (`"\t"`, `"\""`, `"A"`) or even a plain one — AS that
 * backslash key. `JSON.parse('{"a":1}')` can hand back `{ "\\": 1 }`.
 *
 * Why it matters here: every trust boundary parses JSON (MCP bodies, runner
 * jobs, plan files, policy input), and `digest()` hashes the PARSED value, so the
 * digest and the behaviour agree with each other but not with what the sender
 * wrote. Node 22 (V8 12.4, what CI and the Dockerfile pin) is not affected.
 *
 * The defect is STATEFUL: it depends on what this isolate has parsed before, so
 * a handful of fixed probes can miss it. The detector therefore runs a small
 * deterministic fuzz (a few thousand objects of escaped and plain
 * single-character keys, checked against an independent tokenizer); on an
 * affected runtime it finds hundreds of wrong keys in a few milliseconds.
 *
 * Tests that depend on `JSON.parse` being faithful call `skipIfJsonParseBroken`;
 * the skip names the defect, so a green run on an affected machine can never be
 * mistaken for a run that exercised them. `tests/security/runtime-sanity.test.ts`
 * reports the state of the runtime explicitly.
 */
import type { TestContext } from "vitest";

/** Decode the JSON string token starting at `s[i] === '"'`; returns [value, index after the closing quote]. */
function decodeToken(s: string, i: number): [string, number] {
  let j = i + 1;
  let out = "";
  const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/", "\\": "\\", '"': '"' };
  while (s[j] !== '"') {
    if (s[j] === "\\") {
      const n = s[j + 1];
      if (n === "u") {
        out += String.fromCharCode(parseInt(s.slice(j + 2, j + 6), 16));
        j += 6;
      } else {
        out += simple[n];
        j += 2;
      }
    } else {
      out += s[j++];
    }
  }
  return [out, j + 1];
}

/** Keys of a flat `{"k":<number>,…}` object, read without `JSON.parse`. */
function keysWithoutParse(text: string): string[] {
  const keys: string[] = [];
  let i = 1;
  while (i < text.length - 1) {
    const [k, next] = decodeToken(text, i);
    keys.push(k);
    i = next + 1; // skip ':'
    while (text[i] !== "," && text[i] !== "}") i++;
    i++;
  }
  return keys;
}

const POOL = ["a", "\\u0061", "b", '\\"', "\\\\", "/", "\\/", "role", "rol\\u0065", "\\n", "\\t", "é", "\\u00e9", "ab", "a\\u0062", "id", "\\u0069d", " ", "\\u0020", "\\u0022"];

let cached: boolean | undefined;

/** True when `JSON.parse` on this runtime returns a key other than the one in the text. */
export function jsonParseKeyBug(): boolean {
  if (cached !== undefined) return cached;
  let seed = 12345;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000;
  let found = false;
  for (let round = 0; round < 20_000 && !found; round++) {
    const used = new Set<string>();
    const parts: string[] = [];
    for (let i = 1 + Math.floor(next() * 3); i > 0; i--) {
      const k = POOL[Math.floor(next() * POOL.length)];
      if (!used.has(k)) {
        used.add(k);
        parts.push(`"${k}":${parts.length}`);
      }
    }
    const text = `{${parts.join(",")}}`;
    const want = keysWithoutParse(text);
    if (new Set(want).size !== want.length) continue; // two spellings of one key: skip
    const got = Object.keys(JSON.parse(text) as object);
    if ([...got].sort().join("\u0001") !== [...want].sort().join("\u0001")) found = true;
  }
  cached = found;
  return found;
}

export const JSON_PARSE_BUG_REASON =
  `this runtime's JSON.parse returns wrong object keys for single-character keys (V8 >= 12.8.367, nodejs/node#60606; Node ${process.version}, V8 ${process.versions.v8}); ` +
  "Node 22 (CI and Dockerfile) is not affected.";

/** Call at the top of a test (`it("…", (ctx) => { skipIfJsonParseBroken(ctx); … })`). */
export function skipIfJsonParseBroken(ctx: TestContext): void {
  if (jsonParseKeyBug()) ctx.skip(`${JSON_PARSE_BUG_REASON} This test depends on JSON.parse being faithful, so it did NOT run here.`);
}
