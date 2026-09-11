/**
 * HCL encoding — the escaping layer every other module in this directory
 * writes through. Split out of the single-file exporter; the code is
 * unchanged.
 */

/* ------------------------------- HCL encoding ------------------------------ */

/**
 * Everything below exists because a manifest is untrusted input and this file
 * writes a program. The domain schema constrains route hosts and path
 * prefixes, but the exporter cannot lean on that: manifests also arrive from
 * importers, from stored revisions written before a schema tightened, and via
 * fields that are still free text (service and resource names, env keys and
 * values, health paths, image refs, schedules, externalRefs, region and
 * environment names). So every manifest-derived value is encoded here, at the
 * moment it is spliced into HCL, rather than trusted on the way in.
 *
 * There are exactly three shapes a value can take in the output, and each has
 * its own encoder:
 *
 *  - inside a double-quoted string  → `hclBody` / `hclString`
 *  - inside a `#` comment           → `hclComment`
 *  - as an identifier or address    → `tf` (constrained, never escaped)
 */

/**
 * C0/C1 controls plus the two Unicode line separators. None of them belong
 * in a .tf file, and a newline is the whole attack: it ends a `#` comment,
 * or turns one quoted string into two lines of configuration.
 */
export const isControl = (ch: string): boolean => {
  const c = ch.codePointAt(0)!;
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
};

/**
 * The *body* of an HCL2 double-quoted string: escaped, without the quotes, so
 * it can be spliced next to interpolations this module writes itself (e.g.
 * `"/${var.name_prefix}/${hclBody(path)}"`).
 *
 * Beyond the obvious backslash/quote/newline work, the load-bearing line is
 * the last one. In HCL a quoted string is a *template*: `${…}` opens an
 * interpolation and `%{…}` a directive, so a value carrying either is
 * executable configuration rather than data — the difference between a
 * hostname and a call to `file("~/.aws/credentials")`. HCL's own literal form
 * for them is to double the sigil, and doubling only the sigil that actually
 * precedes a `{` is what makes the encoding stable: an input that already
 * reads `$${` comes out as `$$${`, which HCL renders back as the literal
 * `$${` instead of re-arming the interpolation.
 */
export function hclBody(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (isControl(ch)) out += `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  out = out.replace(/([$%])\{/g, (_m, sigil: string) => `${sigil}${sigil}{`);
  // A body is spliced into a larger literal, so a trailing sigil could pair up
  // with a `{` the caller writes next and re-open the hole from outside the
  // value. `$$`/`%%` are only escapes in front of a brace, so the fix is the
  // numeric escape: it survives the template scanner as a plain character.
  return out.replace(/\$$/, "\\u0024").replace(/%$/, "\\u0025");
}

/** A complete HCL2 double-quoted string literal, quotes included. */
export const hclString = (value: unknown): string => `"${hclBody(value)}"`;

/**
 * Text destined for a `#` comment. A comment ends at the first newline, so a
 * value carrying one does not stay a comment — the remainder lands in the
 * parser as configuration. Control characters therefore collapse to a space.
 * Quotes and `${` are inert inside a comment and are left readable.
 */
export function hclComment(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  let out = "";
  for (const ch of s) out += isControl(ch) ? " " : ch;
  return out.replace(/  +/g, " ").trim();
}

/**
 * A whole number for an unquoted attribute. Unquoted positions cannot be
 * escaped at all — whatever is written there is HCL — so a value that is not
 * a finite number is replaced rather than encoded.
 */
export function hclNum(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * A port safe to write unquoted, or nothing at all. Shared by the security
 * group, the task definition and the target group so a port the manifest
 * cannot justify is dropped from all three rather than one.
 */
export const validPort = (value: unknown): number | undefined => {
  const n = hclNum(value, 0);
  return n >= 1 && n <= 65535 ? n : undefined;
};
