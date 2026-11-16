import { pollHandler } from "@/lib/runners/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// long-poll: up to 20 s of waiting plus the claim round trips
export const maxDuration = 30;
export const POST = pollHandler("machine");
