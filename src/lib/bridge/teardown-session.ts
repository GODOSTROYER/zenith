/** Browser teardown proof: same origin, no bearer/actor headers, live identity. */
import { headers } from "next/headers";
import { NextRequest } from "next/server";
import type { ActionContext } from "@/lib/actions/core";
import type { BrowserSessionProof } from "@/lib/capabilities/types";
import { currentRequest } from "@/lib/server/request";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { hostedMode } from "@/lib/hosted/config";
import { verifyRequestIdentity } from "@/lib/hosted/access/identity";

export async function teardownBrowserSession(ctx: ActionContext): Promise<BrowserSessionProof | undefined> {
  if (ctx.integration || ctx.actor.type !== "user" || !currentRequest()) return undefined;
  try {
    const h = await headers();
    if (["authorization", "x-zenith-actor", "x-zenith-actor-key"].some((key) => h.has(key))) return undefined;
    const host = h.get("host");
    if (!host) return undefined;
    const protocol = h.get("x-forwarded-proto") ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
    if (!["http", "https"].includes(protocol)) return undefined;
    const origin = process.env.ZENITH_PLATFORM_ORIGIN ?? process.env.ZENITH_AGENT_ORIGIN ?? `${protocol}://${host}`;
    if (new URL(origin).origin !== origin || h.get("origin") !== origin ||
        (h.has("sec-fetch-site") && h.get("sec-fetch-site") !== "same-origin")) return undefined;
    if (!isSupabaseConfigured()) return !hostedMode() && ctx.actor.id === "local"
      ? { method: "browser_session", subject: "local", verifiedAtMs: Date.now() } : undefined;
    const state = currentRequest();
    const identity = await verifyRequestIdentity(new NextRequest(`${origin}/`, { headers: new Headers(h) }));
    if (!identity.emailVerified || identity.subject !== ctx.actor.id || state?.user?.id !== identity.subject ||
        state.member?.id !== identity.subject || state.member.workspaceId !== ctx.workspaceId) return undefined;
    return { method: "browser_session", subject: identity.subject, verifiedAtMs: Date.now() };
  } catch { return undefined; }
}
