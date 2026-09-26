/** Start a provider link without replacing the signed-in account. */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, SUPABASE_OAUTH_PROVIDERS, type OAuthProvider } from "@/lib/supabase/env";
import { IDENTITY_LINK_COOKIE, IDENTITY_LINK_TTL_SECONDS, type IdentityLinkIntent } from "@/lib/auth/identity-link";

export const dynamic = "force-dynamic";
const failure = (message: string, status: number, fix?: string) =>
  NextResponse.json({ error: { message, fix } }, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: NextRequest) {
  // This endpoint writes authentication cookies. Only a JSON POST from this
  // origin may start a link, even when the caller already has a valid session.
  if (request.headers.get("origin") !== request.nextUrl.origin ||
      !request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    return failure("Open account settings to connect a sign-in method.", 403);
  if (!isSupabaseConfigured()) return failure("Authentication is not configured.", 503);
  const body = await request.json().catch(() => null) as { provider?: unknown } | null;
  const provider = body?.provider;
  if (typeof provider !== "string" || !SUPABASE_OAUTH_PROVIDERS.includes(provider as OAuthProvider))
    return failure("That sign-in provider is not enabled.", 400);

  try {
    const supabase = await createClient();
    const { data: account, error: accountError } = await supabase.auth.getUser();
    if (accountError || !account.user) return failure("Sign in before connecting a provider.", 401);
    if (account.user.identities?.some((identity) => identity.provider === provider))
      return failure("That provider is already connected to this account.", 409, "Reload account settings to see your sign-in methods.");

    const intent: IdentityLinkIntent = {
      userId: account.user.id, provider: provider as OAuthProvider,
      state: randomUUID(), createdAt: Date.now(),
    };
    const callback = new URL("/auth/callback", request.nextUrl.origin);
    callback.searchParams.set("intent", "link");
    callback.searchParams.set("link_state", intent.state);
    const { data, error } = await supabase.auth.linkIdentity({
      provider: intent.provider,
      options: {
        redirectTo: callback.toString(), skipBrowserRedirect: true,
        ...(provider === "google" ? { queryParams: { prompt: "select_account" } } : {}),
      },
    });
    if (error || !data?.url) {
      if (error?.code === "manual_linking_disabled")
        return failure("Connecting sign-in providers is not enabled for this deployment.", 400,
          "Enable manual identity linking in Supabase Authentication settings, then try again.");
      return failure("That provider could not be connected.", 400,
        "Try again. If it already belongs to another account, sign in to that account separately.");
    }
    if (data.flowId) intent.flowId = data.flowId;
    const response = NextResponse.json({ url: data.url }, { headers: { "cache-control": "no-store" } });
    response.cookies.set(IDENTITY_LINK_COOKIE, JSON.stringify(intent), {
      httpOnly: true, secure: request.nextUrl.protocol === "https:",
      sameSite: "lax", path: "/auth/callback", maxAge: IDENTITY_LINK_TTL_SECONDS,
    });
    return response;
  } catch {
    return failure("The authentication service could not be reached.", 503, "Try connecting the provider again in a moment.");
  }
}
