/** Shared offline safety helpers for L1/L2/L3. Provider-specific authority remains in each guarded adapter. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const Reservation = z.object({ runId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), planSha256: z.string().regex(/^[a-f0-9]{64}$/), usd: z.number().finite().nonnegative() }).strict();
const Budget = z.object({ schema: z.literal(1), reservations: z.array(Reservation) }).strict();

/** Conservative lifetime reservation, never refunded. All providers use ONE owner file. */
export function reserveRunBudget(file: string, input: z.infer<typeof Reservation>, totalUsd: number): void {
  if (!path.isAbsolute(file) || !Number.isFinite(totalUsd) || totalUsd <= 0) throw new Error("Use one absolute owner budget FILE with a positive total budget across all live jobs");
  const reservation = Reservation.parse(input);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  writeFileSync(lock, "Live acceptance budget lock\n", { flag: "wx", mode: 0o600 });
  try {
    const book = Budget.parse(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { schema: 1, reservations: [] });
    if (book.reservations.some(r => r.runId === reservation.runId)) throw new Error("Run already reserved; resume cleanup only, never replay effects");
    if (book.reservations.reduce((sum, r) => sum + r.usd, 0) + reservation.usd > totalUsd) throw new Error("Persistent total budget exhausted");
    book.reservations.push(reservation);
    writeFileSync(`${file}.new`, `${JSON.stringify(book)}\n`, { mode: 0o600 });
    renameSync(`${file}.new`, file);
  } finally { unlinkSync(lock); }
}

export function tagsMatch(actual: unknown, expected: Readonly<Record<string, string>>): boolean {
  return !!actual && typeof actual === "object" && !Array.isArray(actual) && Object.keys(expected).length > 0 &&
    Object.entries(expected).every(([key, value]) => Object.prototype.hasOwnProperty.call(actual, key) && (actual as Record<string, unknown>)[key] === value);
}

/** Missing/unreadable inventory cannot become absence evidence. */
export function inventoryEmpty(actual: unknown): boolean { return Array.isArray(actual) && actual.length === 0; }

/** Stop dependent cleanup at the first refusal; callers must still perform leak scans in finally. */
export async function teardownUntilFailure<T>(ordered: readonly T[], perform: (item: T) => Promise<boolean>, stopOnFailure = true): Promise<number> {
  let completed = 0;
  for (const item of ordered) {
    try {
      if (await perform(item)) completed++;
      else if (stopOnFailure) break;
    } catch { if (stopOnFailure) break; }
  }
  return completed;
}
