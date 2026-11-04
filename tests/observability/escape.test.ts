/**
 * Injection tests for query-language construction. Every attack string must
 * come out as ONE escaped literal that decodes back to the original text — the
 * roundtrip is checked with small independent parsers, not by string
 * comparison against the implementation's own output.
 */
import { describe, expect, it } from "vitest";
import {
  cloudWatchFilterPattern,
  equalityMatcher,
  flattenControl,
  insightsStringLiteral,
  logqlStringLiteral,
  lokiLineFilter,
  matchersFrom,
  streamSelector,
  toLabelName,
} from "@/lib/observability/escape";
import { parseGoString } from "./_fixtures";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const CONTROL = new RegExp(`[\x00-\x1f\x7f-\x9f${LS}${PS}]`);

/** Attack strings: quotes, backslashes, backticks, pipes, braces, newlines, query fragments. */
const ATTACKS = [
  'simple',
  'quote " inside',
  'ends with backslash \\',
  '\\" escaped quote attempt',
  '" ?OR "anything',
  '"} |~ ".*" | json | drop',
  '`backtick` and ${template}',
  "pipe | pipe |= not-a-filter",
  "brace } close { open",
  "line1\nline2\r\nline3\ttab",
  `nul-free control \u0001\u001f\u007f\u0085 ${LS} ${PS}`,
  '{job="other"} or {namespace=~".+"}',
  '") or true or ("',
  "unicode ✓ 日本語 🚀",
  "%regex%",
  "- exclusion ? optional",
];

/** CloudWatch quoted term: backslash escapes only a quote or a backslash. */
function parseCloudWatchTerm(s: string): { value: string; rest: string } {
  expect(s[0]).toBe('"');
  let i = 1;
  let out = "";
  for (;;) {
    if (i >= s.length) throw new Error("unterminated term");
    const ch = s[i];
    if (ch === '"') return { value: out, rest: s.slice(i + 1) };
    if (ch === "\\" && (s[i + 1] === '"' || s[i + 1] === "\\")) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
}

describe("logqlStringLiteral", () => {
  it.each(ATTACKS)("round-trips %j as a single literal", (attack) => {
    const lit = logqlStringLiteral(attack);
    const parsed = parseGoString(lit);
    expect(parsed.rest).toBe("");
    expect(parsed.value).toBe(attack);
  });

  it("never leaves a raw newline or control character in the output", () => {
    for (const attack of ATTACKS) {
      const lit = logqlStringLiteral(attack);
      expect(lit).not.toMatch(CONTROL);
    }
  });

  it("uses short escapes for quote/backslash/newline and \\u for other controls", () => {
    expect(logqlStringLiteral('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
    expect(logqlStringLiteral("\u0001")).toBe('"\\u0001"');
    expect(logqlStringLiteral(LS)).toBe(`"${String.fromCharCode(92)}u2028"`);
  });
});

describe("lokiLineFilter and streamSelector", () => {
  it.each(ATTACKS)("keeps %j inside one |= literal", (attack) => {
    const filter = lokiLineFilter(attack);
    expect(filter.startsWith("|= ")).toBe(true);
    const parsed = parseGoString(filter.slice(3));
    expect(parsed.rest).toBe("");
    expect(parsed.value).toBe(attack);
  });

  it("builds a selector from sanitized names and escaped values", () => {
    expect(streamSelector({ app: "web", "app.kubernetes.io/name": 'we"b' })).toBe('{app="web",app_kubernetes_io_name="we\\"b"}');
  });

  it("drops unusable names and empty values; returns undefined for an empty selector", () => {
    expect(streamSelector({})).toBeUndefined();
    expect(streamSelector({ "": "x", __reserved: "x", ok: "" })).toBeUndefined();
    expect(streamSelector({ "1abc": "v" })).toBe('{_1abc="v"}');
  });

  it("a value that tries to close the selector stays inside its literal", () => {
    const sel = streamSelector({ app: 'x"} | {job="other' })!;
    expect(sel).toBe('{app="x\\"} | {job=\\"other"}');
    const inner = sel.slice(sel.indexOf("=") + 1, -1);
    expect(parseGoString(inner)).toEqual({ value: 'x"} | {job="other', rest: "" });
  });

  it("caps matcher count", () => {
    const labels = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`l${i}`, "v"]));
    expect(matchersFrom(labels, 8)).toHaveLength(8);
  });

  it("refuses reserved and invalid names in equalityMatcher", () => {
    expect(equalityMatcher("__name__", "x")).toBeUndefined();
    expect(equalityMatcher("bad-name", "x")).toBeUndefined();
    expect(equalityMatcher("good_name", "x")).toBe('good_name="x"');
  });

  it("toLabelName sanitizes conventional keys", () => {
    expect(toLabelName("app.kubernetes.io/name")).toBe("app_kubernetes_io_name");
    expect(toLabelName("zenith.dev/env")).toBe("zenith_dev_env");
    expect(toLabelName("")).toBeUndefined();
    expect(toLabelName("__x")).toBeUndefined();
  });
});

describe("cloudWatchFilterPattern", () => {
  it.each(ATTACKS)("keeps %j inside one quoted term", (attack) => {
    const pattern = cloudWatchFilterPattern(attack);
    const parsed = parseCloudWatchTerm(pattern);
    expect(parsed.rest).toBe("");
    // control characters are flattened to spaces (documented), everything else round-trips exactly
    expect(parsed.value).toBe(flattenControl(attack));
  });

  it("escapes the backslash before the quote so an escape cannot be consumed", () => {
    expect(cloudWatchFilterPattern('\\"')).toBe('"\\\\\\""');
    expect(cloudWatchFilterPattern("\\")).toBe('"\\\\"');
  });

  it("is a single term: no unescaped quote appears before the final character", () => {
    for (const attack of ATTACKS) {
      const pattern = cloudWatchFilterPattern(attack);
      let escaped = false;
      let quotes = 0;
      for (const ch of pattern.slice(0, -1)) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quotes++;
      }
      expect(quotes).toBe(1); // only the opening quote
      expect(pattern.endsWith('"')).toBe(true);
    }
  });

  it("caps the pattern well under CloudWatch's 1024-character limit", () => {
    expect(cloudWatchFilterPattern('"'.repeat(1000)).length).toBeLessThanOrEqual(1024);
    expect(cloudWatchFilterPattern("\\".repeat(1000)).length).toBeLessThanOrEqual(1024);
  });

  it("does not split a surrogate pair when capping", () => {
    const pattern = cloudWatchFilterPattern("🚀".repeat(1000));
    expect(pattern).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("Logs Insights literal follows the same rules", () => {
    for (const attack of ATTACKS) expect(insightsStringLiteral(attack)).toBe(cloudWatchFilterPattern(attack));
  });
});
