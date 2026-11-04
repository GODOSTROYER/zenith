/** Bearer-only MCP v3. Authority is enforced by the transport, not cookies. */
import { mcpRuntime } from "@/lib/agent-access/v3/runtime";
import { failure, handleMcp } from "@/lib/agent-access/v3/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handler(request: Request): Promise<Response> {
  try { return await handleMcp(request, await mcpRuntime()); }
  catch (error) { return failure(error); }
}
export const GET = handler;
export const POST = handler;
export const DELETE = handler;
