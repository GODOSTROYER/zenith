/**
 * `POST /api/internal/tick/outbox` — drain the alert delivery outbox once.
 *
 * A workspace with a webhook or Slack channel has its notifications written as
 * outbox rows in the same save as the event; something has to push them. On a
 * server that is boot plus the delivery loop, on serverless it is this route.
 * The reclaim lease is a minute rather than zero: another instance may be
 * mid-send right now. See `src/lib/server/cron.ts`.
 */
import { cronRoute, outboxTickPass } from "@/lib/server/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = cronRoute("outbox", async () => ({ ...(await outboxTickPass()) }));
