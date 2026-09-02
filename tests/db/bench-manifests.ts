/**
 * What the manifest split costs a save. Not a test — run it by hand:
 *
 *   ORRERY_DATA=<empty scratch dir> npx tsx tests/db/bench-manifests.ts <seeded dir>
 *
 * "before" is the old shape (manifests inline in state.json), reconstructed by
 * stitching the side files back in; "after" is the real `flush()`. Both write
 * the same way — stringify, tmp file, rename — so the difference is the
 * payload, which is the whole point.
 */
import fs from "node:fs";
import path from "node:path";

import { db, flush, resetDb } from "@/lib/db/store";

const SEEDED = process.argv[2];
const BENCH = process.env.ORRERY_DATA;
if (!SEEDED || !BENCH)
  throw new Error(
    "usage: ORRERY_DATA=<empty scratch dir> npx tsx tests/db/bench-manifests.ts <seeded dir>"
  );

type Db = ReturnType<typeof db>;

/** The seeded store with every manifest stitched back inline: the old shape. */
function inlineSnapshot(dir: string): Db {
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as Db;
  for (const r of state.revisions)
    r.manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "revisions", `${encodeURIComponent(r.id)}.json`), "utf8")
    );
  return state;
}

const RUNS = 500;
const WRITES = 50;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
/** Grouped by thousands regardless of the shell's locale. */
const n = (x: number): string => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The store's write path exactly as it was before the split. */
function oldWrite(data: Db): number {
  const file = path.join(BENCH!, "old-state.json");
  const text = JSON.stringify(data);
  fs.writeFileSync(`${file}.tmp`, text, "utf8");
  fs.renameSync(`${file}.tmp`, file);
  return Buffer.byteLength(text);
}

function time(runs: number, fn: () => void): number {
  fn(); // warm the filesystem cache; we are measuring a save, not a cold open
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  return median(samples);
}

function bench(label: string, data: Db): void {
  // Serialisation is what the split changes, and it is deterministic. The
  // write+rename around it is a syscall pair whose cost belongs to the
  // filesystem, and on Windows it swamps everything — so both are reported.
  const beforeSer = time(RUNS, () => void JSON.stringify(data));
  const beforeMs = time(WRITES, () => oldWrite(data));
  const beforeBytes = oldWrite(data);

  // Same data through the new store: resetDb takes the inline manifests and
  // the first flush moves them out.
  resetDb(structuredClone(data));
  flush();
  const live = db();
  const afterSer = time(RUNS, () => void JSON.stringify(live));
  const afterMs = time(WRITES, () => flush());
  const afterBytes = fs.statSync(path.join(BENCH!, "state.json")).size;

  const cold = fs
    .readdirSync(path.join(BENCH!, "revisions"))
    .reduce((acc, f) => acc + fs.statSync(path.join(BENCH!, "revisions", f)).size, 0);

  const drop = (a: number, b: number): string => `${(100 - (b / a) * 100).toFixed(1)}%`;
  console.log(
    [
      "",
      `${label} — ${data.revisions.length} revision(s)`,
      `  bytes serialised   ${n(beforeBytes)} -> ${n(afterBytes)} per save   (-${drop(beforeBytes, afterBytes)})`,
      `  serialise          ${beforeSer.toFixed(3)} -> ${afterSer.toFixed(3)} ms   (-${drop(beforeSer, afterSer)})`,
      `  whole save         ${beforeMs.toFixed(2)} -> ${afterMs.toFixed(2)} ms   (-${drop(beforeMs, afterMs)})`,
      `  cold storage       ${n(cold)} B in revisions/, written once each`,
    ].join("\n")
  );
}

const demo = inlineSnapshot(SEEDED);
bench("seeded demo", demo);

/** Same store, 500 deploys deep — where the old shape actually hurt. */
const synthetic = structuredClone(demo);
const template = demo.revisions[demo.revisions.length - 1];
synthetic.revisions = Array.from({ length: 500 }, (_, i) => ({
  ...structuredClone(template),
  id: `rev-bench-${i}`,
  number: i + 1,
}));
bench("synthetic history", synthetic);

fs.rmSync(BENCH, { recursive: true, force: true });
