/**
 * Every relative link in the platform documentation must resolve: the file or
 * directory must exist, and a `#heading` fragment on a markdown file must match
 * a real heading (GitHub's anchor rules). External links are not fetched.
 *
 * Scope: all of `docs/platform/**` (including the generated capability matrix),
 * plus the two sections this workstream added to `README.md` and
 * `docs/LIMITATIONS.md`.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, checkLink, extractLinks, headingAnchors, read, stripCode, walk, type LinkProblem } from "./markdown";

const PLATFORM_DOCS = path.join(REPO_ROOT, "docs", "platform");

const describeProblem = (p: LinkProblem): string => `${path.relative(REPO_ROOT, p.file).replace(/\\/g, "/")}:${p.line} -> ${p.target}: ${p.reason}`;

function problemsIn(file: string, filter: (line: number) => boolean = () => true): LinkProblem[] {
  return extractLinks(file, read(file))
    .filter((l) => filter(l.line))
    .map((l) => checkLink(l, { checkAnchors: true }))
    .filter((p): p is LinkProblem => p !== undefined);
}

describe("links in docs/platform/**", () => {
  const files = walk(PLATFORM_DOCS);

  it("finds the documentation set (so an empty glob cannot pass)", () => {
    const names = files.map((f) => path.relative(PLATFORM_DOCS, f).replace(/\\/g, "/"));
    for (const expected of [
      "ARCHITECTURE.md",
      "CAPABILITY-MATRIX.md",
      "operations/README.md",
      "operations/DEPLOYING.md",
      "operations/RECOVERY.md",
      "operations/AWS-SETUP.md",
      "operations/POLICY.md",
      "operations/COST.md",
    ]) {
      expect(names).toContain(expected);
    }
    const total = files.reduce((n, f) => n + extractLinks(f, read(f)).length, 0);
    expect(total).toBeGreaterThan(40);
  });

  it("every relative link resolves to an existing path, and every anchor to a heading", () => {
    const problems = files.flatMap((f) => problemsIn(f)).map(describeProblem);
    expect(problems).toEqual([]);
  });
});

describe("links in the sections added to README.md and docs/LIMITATIONS.md", () => {
  it("resolve", () => {
    const readme = path.join(REPO_ROOT, "README.md");
    const limits = path.join(REPO_ROOT, "docs", "LIMITATIONS.md");
    const sectionLines = (file: string, heading: string): ((line: number) => boolean) => {
      const lines = read(file).split("\n");
      const start = lines.findIndex((l) => l.startsWith(heading));
      expect(start, `${heading} must exist in ${path.basename(file)}`).toBeGreaterThanOrEqual(0);
      const next = lines.findIndex((l, i) => i > start && (/^## /.test(l) || /^---\s*$/.test(l)));
      const end = next === -1 ? lines.length : next;
      return (line) => line - 1 >= start && line - 1 < end;
    };
    const problems = [
      ...problemsIn(readme, sectionLines(readme, "## Platform control plane (in progress)")),
      ...problemsIn(limits, sectionLines(limits, "## Platform control plane (in progress)")),
    ].map(describeProblem);
    expect(problems).toEqual([]);
  });

  it("the sections exist, say 'in progress' and link to the operator docs and the matrix", () => {
    for (const file of [path.join(REPO_ROOT, "README.md"), path.join(REPO_ROOT, "docs", "LIMITATIONS.md")]) {
      const text = read(file);
      const at = text.indexOf("## Platform control plane (in progress)");
      expect(at, file).toBeGreaterThanOrEqual(0);
      const section = text.slice(at, at + 4000);
      expect(section).toMatch(/operations/);
      expect(section).toMatch(/CAPABILITY-MATRIX\.md|capability matrix/);
    }
  });
});

describe("the link checker itself (negative controls)", () => {
  const file = path.join(PLATFORM_DOCS, "operations", "README.md");

  it("reports a missing file", () => {
    expect(checkLink({ file, line: 1, target: "NOPE.md" }, { checkAnchors: true })?.reason).toMatch(/no such file/);
  });

  it("reports a missing heading but accepts a real one", () => {
    expect(checkLink({ file, line: 1, target: "DEPLOYING.md#no-such-heading" }, { checkAnchors: true })?.reason).toMatch(/no heading/);
    expect(checkLink({ file, line: 1, target: "DEPLOYING.md#2-environment-variables" }, { checkAnchors: true })).toBeUndefined();
    expect(checkLink({ file, line: 1, target: "#what-is-merged-and-where-it-is-documented" }, { checkAnchors: true })).toBeUndefined();
  });

  it("ignores external links and code samples", () => {
    expect(checkLink({ file, line: 1, target: "https://example.com/x.md" }, { checkAnchors: true })).toBeUndefined();
    const md = "see `[not](a-link.md)` and\n\n```\n[also not](nothing.md)\n```\n[real](x.md)";
    expect(extractLinks(file, md).map((l) => l.target)).toEqual(["x.md"]);
    expect(stripCode(md)).not.toContain("a-link.md");
  });

  it("computes GitHub anchors: punctuation dropped, inline code kept, duplicates numbered", () => {
    const anchors = headingAnchors("# A. Title\n## `Code` here\n## Same\n## Same\n```\n## not a heading\n```\n");
    expect([...anchors].sort()).toEqual(["a-title", "code-here", "same", "same-1"]);
  });
});
