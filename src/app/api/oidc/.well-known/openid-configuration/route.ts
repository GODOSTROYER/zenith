import { discoveryResponse } from "@/lib/credentials/oidc/http";

/**
 * OIDC discovery for Zenith's workload-identity issuer (`<origin>/api/oidc`).
 * Public and unauthenticated by design; serves metadata only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request): Promise<Response> => discoveryResponse(req);
