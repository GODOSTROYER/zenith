/**
 * `.terraform.lock.hcl` reading and assembly.
 *
 * A lockfile is a header plus one `provider "<source>" { … }` block per
 * provider; blocks are independent, so a set's lockfile can be assembled from
 * per-provider blocks (`scripts/lock.ts` locks each provider once and derives
 * every set from those). The parser here is deliberately narrow: it reads only
 * the fields the engine verifies (`version`, `constraints`, `hashes`) from the
 * format tofu itself writes.
 */
import { EMPTY_LOCKFILE } from "@/lib/tofu/providers";

export interface LockedProvider {
  /** e.g. `registry.opentofu.org/hashicorp/aws` */
  source: string;
  version: string;
  constraints?: string;
  hashes: string[];
  /** the raw block text, without surrounding blank lines */
  block: string;
}

const HEADER = EMPTY_LOCKFILE;

export function splitLockBlocks(lockfile: string): LockedProvider[] {
  const out: LockedProvider[] = [];
  const lines = lockfile.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const m = /^provider "([^"]+)" \{\s*$/.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i] !== "}") i++;
    const blockLines = lines.slice(start, i + 1);
    const block = blockLines.join("\n");
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1] ?? "";
    const constraints = /^\s*constraints\s*=\s*"([^"]*)"/m.exec(block)?.[1];
    const hashes = [...(/hashes\s*=\s*\[([\s\S]*?)\n\s*\]/.exec(block)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((h) => h[1]);
    out.push({ source: m[1], version, constraints, hashes, block });
    i++;
  }
  return out;
}

/** Assemble a lockfile from blocks, sorted by source, in tofu's own layout. */
export function assembleLockfile(blocks: readonly LockedProvider[]): string {
  if (blocks.length === 0) return HEADER;
  const sorted = [...blocks].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  return `${HEADER}\n${sorted.map((b) => b.block).join("\n\n")}\n`;
}
