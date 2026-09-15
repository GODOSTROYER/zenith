import { gateway } from "@/lib/agent-access/control/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Dispatch + the bounded post-dispatch engine advance (CONTROL-PLANE-ON-POSTGRES.md §7.3).
export const maxDuration = 60;
export const GET = gateway;
export const POST = gateway;
