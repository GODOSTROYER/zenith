import { listRoute } from "@/lib/runners/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = listRoute("runner");
