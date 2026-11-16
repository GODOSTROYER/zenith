/**
 * `POST /api/agent/oauth/revoke` — RFC 7009 token revocation for linked
 * credentials (`za_`), plugin tokens (`zp_`) and OAuth access tokens (by
 * revoking the Zenith grant). Authorized by possession of the token; on the
 * middleware bypass list because it carries no cookie. Effective on the
 * token's next MCP request. See src/lib/agent-access/oauth/revoke.ts.
 */
import { revokeToken } from "@/lib/agent-access/oauth/revoke";
import { defaultRevokeDeps } from "@/lib/agent-access/oauth/revoke-default";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  return revokeToken(request, defaultRevokeDeps());
}
export const GET = POST;
