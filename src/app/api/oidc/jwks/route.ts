import { jwksResponse } from "@/lib/credentials/oidc/http";

/**
 * Public signing keys (current + next/previous) for the workload-identity
 * issuer. PUBLIC keys only; the response is CDN-cacheable for 5 minutes.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request): Promise<Response> => jwksResponse(req);
