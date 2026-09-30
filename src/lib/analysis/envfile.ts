/**
 * `.env`-style files: names only, ever.
 *
 * A committed `.env` is a security finding, not an input. The snapshot builder
 * rewrites every such file with `redactEnvFile` before the text is kept, so a
 * secret value never reaches the analyser (or anything downstream) at all;
 * `parseEnvFile` reads either that redacted form or a raw file a caller built
 * by hand, and reports only the name, the line and two booleans.
 */
import { isEnvName, lines, looksLikeSecretValue } from "./text";

/** Replaces a non-empty value in a redacted file. */
export const ENV_SET = "<set>";
/** Replaces a non-empty value that looks like a credential. */
export const ENV_SET_SECRETLIKE = "<set:secret-like>";

export interface EnvAssignment {
  name: string;
  line: number;
  /** The file gives this name a non-empty value. */
  hasValue: boolean;
  /** The value (not recorded) looks like a credential. */
  secretLike: boolean;
}

const ASSIGNMENT = /^\s{0,20}(?:export\s{1,5})?([A-Za-z_][A-Za-z0-9_]{0,99})\s{0,5}=(.*)$/;

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  // drop a trailing inline comment on an unquoted value
  const hash = t.indexOf(" #");
  return hash === -1 ? t : t.slice(0, hash).trim();
}

export function parseEnvFile(content: string): EnvAssignment[] {
  const out: EnvAssignment[] = [];
  for (const { n, text } of lines(content)) {
    const m = ASSIGNMENT.exec(text);
    if (!m || !isEnvName(m[1])) continue;
    const value = unquote(m[2]);
    const marker = value === ENV_SET_SECRETLIKE;
    out.push({
      name: m[1],
      line: n,
      hasValue: value !== "",
      secretLike: marker || (value !== ENV_SET && looksLikeSecretValue(value)),
    });
  }
  return out;
}

/**
 * Same number of lines, but every value is replaced by a marker. Comments and
 * anything that is not an assignment become empty lines.
 */
export function redactEnvFile(content: string): string {
  const parsed = new Map(parseEnvFile(content).map((a) => [a.line, a] as const));
  const out: string[] = [];
  const all = lines(content);
  for (const { n } of all) {
    const a = parsed.get(n);
    out.push(a ? `${a.name}=${a.hasValue ? (a.secretLike ? ENV_SET_SECRETLIKE : ENV_SET) : ""}` : "");
  }
  return out.join("\n");
}

/** Names that mean "this is an example/template", which is expected to be committed. */
const EXAMPLE_SUFFIX = /\.(?:example|sample|template|dist|defaults?|tpl|schema)$/i;

/** Is this file name a `.env` file of any kind? */
export const isEnvFileName = (base: string): boolean => base === ".env" || base.startsWith(".env.");

/** `.env.example` and friends: safe to commit, read for names. */
export const isEnvExampleName = (base: string): boolean => isEnvFileName(base) && EXAMPLE_SUFFIX.test(base);
