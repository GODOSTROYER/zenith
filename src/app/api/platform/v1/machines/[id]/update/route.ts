import { readUpdateRoute, writeUpdateRoute } from "@/lib/runners/update-control";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = readUpdateRoute("machine");
export const POST = writeUpdateRoute("machine");
