import { revokeRoute } from "@/lib/runners/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = revokeRoute("machine");
