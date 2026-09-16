import { upload } from "@/lib/agent-access/control/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 20 MiB body; boundedBody already has a 20s read timeout (control/boundary.ts).
export const maxDuration = 60;
export const POST = upload;
