import { updateHeartbeatHandler } from "@/lib/runners/update-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = updateHeartbeatHandler("machine");
