import { readUpdateRoute, writeUpdateRoute } from "@/lib/runners/update-control";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = readUpdateRoute("runner");
export const POST = writeUpdateRoute("runner");
