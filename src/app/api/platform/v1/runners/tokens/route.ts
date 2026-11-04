import { createTokenRoute } from "@/lib/runners/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// creates a registration token for a runner OR a machine (body.kind); shown once
export const POST = createTokenRoute;
