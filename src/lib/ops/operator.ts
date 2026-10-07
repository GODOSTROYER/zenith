/**
 * Who may change maintenance mode and tenant quotas (PROD-OPS-02).
 *
 * Platform operators only: a signed-in browser session whose Supabase user id is
 * listed in `ZENITH_OPS_ADMIN_IDS`. A workspace role never confers it, an
 * integration bearer never reaches these routes, and there is no shared-secret
 * fallback on the request path. (A host that cannot reach its auth provider can
 * still enter maintenance by setting `ZENITH_MAINTENANCE_MODE`; that is a
 * deployment action, not a request.) Mutations also require same-origin.
 */
import type { NextRequest } from "next/server";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import { ApiError } from "@/lib/server/errors";
import { sessionUserFromRequest } from "@/lib/supabase/route";
import { sameOrigin } from "@/lib/waitlist/http";
import { opsAdminIds } from "./config";
import { platformConfigured } from "./runtime";
import type { Sql } from "@/lib/controlplane/types";

export async function requireOpsOperator(request: NextRequest, mutating: boolean): Promise<{ id: string }> {
  const user = await sessionUserFromRequest(request);
  if (!user) throw new ApiError("Sign in to manage platform operations.", 401);
  if (!opsAdminIds().has(user.id)) throw new ApiError("Platform operator access is required.", 403, { fix: "Ask an operator to add your user id to ZENITH_OPS_ADMIN_IDS." });
  if (mutating) sameOrigin(request);
  return { id: user.id };
}

export async function opsStore(): Promise<Sql> {
  if (!platformConfigured()) throw new ApiError("The platform control store is not configured on this host.", 503);
  const { platformDb } = await import("@/lib/controlplane/db");
  try { return await platformDb(); } catch { throw new ApiError("The platform control store is unavailable. Maintenance can still be set with ZENITH_MAINTENANCE_MODE on the host.", 503); }
}

/** Map a store refusal to the API's error shape; anything else is rethrown. */
export function storeFailure(error: unknown): never {
  if (error instanceof ControlStoreError) {
    if (error.code === "invalid_input") throw new ApiError(error.message, 400);
    if (error.code === "conflict") throw new ApiError(error.message, 409, { fix: "Reload the current value and retry with its version." });
  }
  throw error;
}
