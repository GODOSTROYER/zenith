import { logsHandler } from "@/lib/runners/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = logsHandler("runner");
