import { agentReader } from "@/lib/agent-access/zenith-reader";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Deliberately not route(): that wrapper resolves browser/demo identity.
export const POST = agentReader;
export const GET = agentReader;
export const DELETE = agentReader;
export const OPTIONS = agentReader;
