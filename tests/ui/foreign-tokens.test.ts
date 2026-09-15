/**
 * Class names from a design system this product does not have.
 *
 * The integrations screen styled its quiet text with `text-muted-foreground` —
 * a shadcn/ui token nothing here defines, so the class did nothing and the text
 * it was meant to quieten rendered at full weight. A class that silently does
 * nothing is invisible in review and invisible in a typecheck, so it is worth a
 * test: the product's own tokens (`text-ink-mute`, `bg-bg2`, and the rest, see
 * globals.css) are the only ones that exist.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** Tokens from the shadcn/ui palette, none of which are defined in this theme. */
const FOREIGN =
  /\b(?:text|bg|border|ring|fill|stroke|from|to|via)-(?:muted-foreground|foreground|background|muted|popover|popover-foreground|card-foreground|primary-foreground|secondary-foreground|accent-foreground|destructive-foreground|input)\b/;

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(tsx?|css)$/.test(entry)) yield path;
  }
}

describe("the product's own tokens are the only ones used", () => {
  it("has no class from a design system this app does not ship", () => {
    const offenders: string[] = [];
    for (const path of files(SRC)) {
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (FOREIGN.test(line)) offenders.push(`${path.slice(SRC.length + 1)}:${i + 1}  ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("looks at the source it claims to", () => {
    // A guard on the guard: a walk that finds nothing proves nothing.
    expect([...files(SRC)].length).toBeGreaterThan(100);
    expect(FOREIGN.test('<p className="text-sm text-muted-foreground">x</p>')).toBe(true);
    expect(FOREIGN.test('<p className="text-[13px] text-ink-mute">x</p>')).toBe(false);
  });
});
