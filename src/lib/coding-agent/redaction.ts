/** Model and handoff boundary. Heuristics are defence in depth, not proof that source contains no secrets. */
import { redactCredentials } from "@/lib/credentials/redact";
import type { RepoSnapshot } from "@/lib/analysis/types";

export const SOURCE_REDACTION_VERSION = "source-v1";
const MASK = "[REDACTED]";
const SECRET_KEY = /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;
const reference = (value: string): boolean => /^(?:vault:[A-Za-z0-9_./-]+|\$\{[A-Za-z_]\w*\}|(?:process\.env|env|import\.meta\.env)\.[A-Za-z_]\w*|os\.environ\[["'][A-Za-z_]\w*["']\]|(?:os\.environ\.get|Deno\.env\.get)\(["'][A-Za-z_]\w*["']\))$/.test(value) || value === MASK;

/** Preserve newlines so source evidence still identifies the same line after redaction. */
export function redactSourceText(text: string): string {
  let value = text.replace(/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
    match => MASK + (match.match(/\r?\n/g) ?? []).join(""));
  value = value.split("\n").map(line => redactCredentials(line)).join("\n");
  value = value.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-(?:ant-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{16,})|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, MASK);
  value = value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`);
  value = value.replace(/(["']?[\w$.-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)[\w$.-]*["']?[ \t]*[:=][ \t]*)(["'`])([^\r\n]*?)\2/gi,
    (_match, prefix: string, quote: string, secret: string) => `${prefix}${quote}${secret && !reference(secret) ? MASK : secret}${quote}`);
  // YAML/INI/shell and JS scalar assignments may be unquoted. Match only this
  // line so a key with no value cannot consume the next line of evidence.
  value = value.replace(/(["']?[\w$.-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)[\w$.-]*["']?[ \t]*[:=][ \t]*)(?!["'`\s])([^\r\n,;#]+)/gi,
    (_match, prefix: string, raw: string) => {
      const secret = raw.trimEnd();
      if (reference(secret) || secret.startsWith(MASK) || /^[>|][+-]?$/.test(secret)) return prefix + raw;
      // Keep a surrounding JS/JSON object's delimiters when present.
      const suffix = raw.match(/([ \t]*[}\]][ \t]*)$/)?.[1] ?? raw.slice(secret.length);
      return prefix + MASK + suffix;
    });
  const sourceLines = value.split("\n");
  let blockIndent: number | undefined;
  value = sourceLines.map(line => {
    if (blockIndent !== undefined) {
      if (!line.trim()) return line;
      const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
      if (indent > blockIndent) return line.slice(0, indent) + MASK;
      blockIndent = undefined;
    }
    const block = /^([ \t]*)["']?[\w.-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)[\w.-]*["']?[ \t]*:[ \t]*[>|][+-]?[ \t]*(?:#.*)?$/i.exec(line);
    if (block) blockIndent = block[1].length;
    return line;
  }).join("\n");
  value = value.replace(/(^|[?&\s])((?:access_token|api_key|password|client_secret)=)([^\s&#;"'`]+)/gi,
    (_match, before: string, key: string, secret: string) => `${before}${key}${reference(secret) ? secret : MASK}`);
  return value;
}

/** JSON-like values only; shared references remain independent and cycles fail closed. */
export function redactSourceValue<T>(value: T): T {
  const ancestors = new Set<object>();
  const visit = (item: unknown, key = "", sensitiveParent = false): unknown => {
    const sensitive = sensitiveParent || SECRET_KEY.test(key);
    if (typeof item === "string") return sensitive && item && !reference(item) ? MASK : redactSourceText(item);
    if (item === null || typeof item !== "object") return item;
    if (ancestors.has(item)) return "[Circular]";
    ancestors.add(item);
    const result = Array.isArray(item) ? item.map(v => visit(v, "", sensitive)) : Object.fromEntries(Object.entries(item).map(([k, v]) => [redactSourceText(k), visit(v, k, sensitive)]));
    ancestors.delete(item);
    return result;
  };
  return visit(value) as T;
}

export function redactedSnapshot(snapshot: RepoSnapshot): RepoSnapshot {
  return { ...snapshot, files: snapshot.files.map(file => ({ ...file, content: redactSourceText(file.content) })) };
}
