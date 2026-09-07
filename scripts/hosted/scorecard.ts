/**
 * Print the activation scorecard as JSON.
 *
 * Run:
 *   npx tsx --env-file-if-exists=.env.local scripts/hosted/scorecard.ts
 *   npx tsx --env-file-if-exists=.env.local scripts/hosted/scorecard.ts --since=2026-09-01 --until=2026-09-28
 *
 * Defaults to the last 30 days. Every measure carries its own definition, its
 * `n`, and `unknown: true` with a reason wherever there is not enough data —
 * the point of this file is that a number in it can be quoted, and a missing
 * number cannot be mistaken for a zero.
 *
 * Workstream W8 (hosted R3).
 */
import { closeAuthority, openAuthority } from "@/lib/hosted/authority";
import { scorecard } from "@/lib/hosted/events";
import { fail, finish } from "./_cli";

const option = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

/** A day or a full timestamp, normalised to an ISO instant. */
function instant(raw: string | undefined, fallback: Date): string {
  if (!raw) return fallback.toISOString();
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw);
  if (!Number.isFinite(parsed)) {
    process.stderr.write(`"${raw}" is not a date. Use YYYY-MM-DD or a full ISO timestamp.\n`);
    process.exit(2);
  }
  return new Date(parsed).toISOString();
}

async function main(): Promise<void> {
  const now = new Date();
  const since = instant(option("since"), new Date(now.getTime() - 30 * 24 * 60 * 60_000));
  const until = instant(option("until"), now);

  openAuthority();
  try {
    const card = scorecard({ since, until });
    process.stdout.write(`${JSON.stringify(card, null, 2)}\n`);
    const unknown = Object.values(card.metrics).filter((metric) => metric.unknown);
    finish(
      `\n${card.events} events between ${since} and ${until}. ` +
        `${unknown.length} of ${Object.keys(card.metrics).length} measures are unknown${unknown.length ? `: ${unknown.map((metric) => metric.id).join(", ")}` : ""}.\n` +
        (card.salted ? "" : "ZENITH_EVENTS_SALT is unset, so no per-person measure could be computed.\n")
    );
  } finally {
    closeAuthority();
  }
}

main().catch(fail);
