/** Exact signed transport; middleware must exempt only this POST from cookies. */
import { platformDb } from "@/lib/controlplane/db/open";
import { createGithubWebhookHandler } from "@/lib/sources/github/webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = createGithubWebhookHandler({ db: platformDb });
