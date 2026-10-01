/**
 * Small markdown helpers for the documentation tests: list files, extract
 * links and headings (ignoring code), and turn a heading into the anchor GitHub
 * gives it. Deliberately narrow; this is a link checker, not a markdown parser.
 */
import fs from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Every file under `dir` (recursively) whose name ends with `ext`, as absolute paths, sorted. */
export function walk(dir: string, ext = ".md"): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith(ext)) out.push(full);
    }
  };
  visit(dir);
  return out.sort();
}

export const read = (file: string): string => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/** Blank fenced code blocks (line for line); everything else, inline code included, is left as it is. */
export function stripFences(markdown: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split("\n")) {
    const opening = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === undefined && opening) {
      fence = opening[1][0];
      out.push("");
      continue;
    }
    if (fence !== undefined) {
      if (new RegExp(`^\\s*${fence}{3,}\\s*$`).test(line)) fence = undefined;
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Blank fenced blocks and inline code spans, so their contents are never parsed as links. */
export function stripCode(markdown: string): string {
  return stripFences(markdown)
    .split("\n")
    .map((line) => line.replace(/(`+)[^`\n]*?\1/g, (span) => " ".repeat(span.length)))
    .join("\n");
}

export interface MdLink {
  file: string;
  line: number;
  target: string;
}

/** Inline `[text](target)` and `![alt](target)` links, and reference definitions `[id]: target`. */
export function extractLinks(file: string, markdown: string): MdLink[] {
  const links: MdLink[] = [];
  const lines = stripCode(markdown).split("\n");
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) links.push({ file, line: i + 1, target: m[1] });
    const ref = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/.exec(text);
    if (ref) links.push({ file, line: i + 1, target: ref[1] });
  });
  return links;
}

/** GitHub's heading anchor: lowercase, drop punctuation except `-`, spaces to `-`; duplicates get `-1`, `-2`. */
export function headingAnchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const line of stripFences(markdown).split("\n")) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const text = heading[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_~`]/g, "")
      .toLowerCase();
    const base = text
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

export interface LinkProblem {
  file: string;
  line: number;
  target: string;
  reason: string;
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const rel = (p: string): string => path.relative(REPO_ROOT, p).replace(/\\/g, "/");

/**
 * Check one link. The path must exist (file or directory). When `checkAnchors`
 * is set and the link names a fragment of a markdown file, that heading must exist.
 */
export function checkLink(link: MdLink, options: { checkAnchors: boolean }): LinkProblem | undefined {
  const { target } = link;
  if (EXTERNAL.test(target)) return undefined;
  const [rawPath, ...rest] = target.split("#");
  const fragment = rest.join("#");
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath.split("?")[0]);
  } catch {
    return { ...link, reason: "the link is not valid percent-encoding" };
  }
  const resolved = decoded === "" ? link.file : path.resolve(path.dirname(link.file), decoded);
  if (!fs.existsSync(resolved)) return { ...link, reason: `no such file or directory: ${rel(resolved)}` };
  if (options.checkAnchors && fragment !== "" && fs.statSync(resolved).isFile() && resolved.endsWith(".md")) {
    const anchors = headingAnchors(read(resolved));
    if (!anchors.has(decodeURIComponent(fragment).toLowerCase())) return { ...link, reason: `no heading for #${fragment} in ${rel(resolved)}` };
  }
  return undefined;
}
