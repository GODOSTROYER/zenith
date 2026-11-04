import { registerHandler } from "@/lib/runners/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = registerHandler("runner");
