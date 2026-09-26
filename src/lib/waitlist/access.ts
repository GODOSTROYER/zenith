import type { User } from "@supabase/supabase-js";
import { ApiError } from "@/lib/server/errors";
import { waitlistConfig, waitlistGateEnabled } from "./config";

export { waitlistGateEnabled };

export type WaitlistAccess = {
  allowed: boolean;
  reason: "disabled" | "operator" | "existing-account" | "admitted" | "waiting";
};

/** Platform operators are explicitly configured IDs, never workspace roles. */
export function isWaitlistOperator(user: { id: string } | null): boolean {
  return Boolean(user && waitlistConfig().adminIds.has(user.id));
}

/**
 * Uses canonical auth records, not user metadata, claims supplied by the caller,
 * or workspace membership. An invitation cannot manufacture an admission.
 * There is intentionally no authorization cache: revocations and email changes
 * take effect on the next protected request. Outages fail closed.
 */
export async function getWaitlistAccess(user: { id: string; email: string } | null): Promise<WaitlistAccess> {
  const config = waitlistConfig();
  if (!config.gateEnabled) return { allowed: true, reason: "disabled" };
  if (!user) return { allowed: false, reason: "waiting" };
  if (config.adminIds.has(user.id)) return { allowed: true, reason: "operator" };

  let canonical: User;
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data, error } = await createAdminClient().auth.admin.getUserById(user.id);
    if (error || !data.user || data.user.id !== user.id) throw new Error("Identity is unavailable.");
    canonical = data.user;
  } catch {
    // Supabase can return an error or reject on a transport failure. Both deny
    // access with the same retryable response, without leaking provider detail.
    throw new ApiError("Access could not be verified. Please try again shortly.", 503);
  }
  const createdAt = Date.parse(canonical.created_at);
  if (Number.isFinite(createdAt) && createdAt < Date.parse(config.existingUsersBefore!))
    return { allowed: true, reason: "existing-account" };
  if (!canonical.email || !canonical.email_confirmed_at)
    return { allowed: false, reason: "waiting" };

  const { waitlistRepository } = await import("./repository");
  return await (await waitlistRepository()).admitted(canonical.email)
    ? { allowed: true, reason: "admitted" }
    : { allowed: false, reason: "waiting" };
}

export async function requireWaitlistAccess(user: { id: string; email: string } | null): Promise<void> {
  if (!(await getWaitlistAccess(user)).allowed)
    throw new ApiError("Your account is waiting for access.", 403, { fix: "Open /waitlist to check access." });
}