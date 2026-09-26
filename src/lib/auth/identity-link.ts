/** Server-side correlation for linking an OAuth provider to the current account. */
import type { OAuthProvider } from "@/lib/supabase/env";

export const IDENTITY_LINK_COOKIE = "zenith-identity-link";
export const IDENTITY_LINK_TTL_SECONDS = 10 * 60;
export interface IdentityLinkIntent {
  userId: string;
  provider: OAuthProvider;
  state: string;
  createdAt: number;
  /** Auth SDK verifier slot; older SDKs omit it and use their legacy key. */
  flowId?: string;
}

export function readIdentityLinkIntent(value: string | undefined): IdentityLinkIntent | null {
  if (!value || value.length > 2048) return null;
  try {
    const intent = JSON.parse(value) as Partial<IdentityLinkIntent>;
    if (typeof intent.userId !== "string" || !intent.userId ||
        (intent.provider !== "google" && intent.provider !== "github") ||
        typeof intent.state !== "string" || intent.state.length < 32 ||
        (intent.flowId !== undefined && typeof intent.flowId !== "string") ||
        typeof intent.createdAt !== "number" || !Number.isFinite(intent.createdAt) ||
        intent.createdAt > Date.now() || Date.now() - intent.createdAt > IDENTITY_LINK_TTL_SECONDS * 1000)
      return null;
    return intent as IdentityLinkIntent;
  } catch {
    return null;
  }
}
