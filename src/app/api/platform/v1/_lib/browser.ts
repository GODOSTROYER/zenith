/**
 * The browser-only guard for the routes a model must never reach: approve,
 * reject, and the admin settings that loosen protections (autonomy, workspace
 * policy). The same approach as `agent-access/control/browser.ts`, in order:
 *
 *  1. ANY `Authorization` header is refused outright (403). An agent credential
 *     is, by construction, not a person in a browser; there is no header value
 *     that makes it one. The Navigator's actor headers are refused the same way.
 *  2. A state-changing request must carry an `Origin` header that is EXACTLY the
 *     Zenith origin (`ZENITH_PLATFORM_ORIGIN`, else `ZENITH_AGENT_ORIGIN`, else
 *     the request's own origin) — no prefix, no subdomain, no `null`. If the
 *     browser sends `Sec-Fetch-Site`, it must say `same-origin`.
 *  3. The identity is verified LIVE with the identity provider
 *     (`verifyRequestIdentity` → `auth.getUser()`), not from a JWT claim: a
 *     signed-out or disabled account stops working immediately. Unavailable is
 *     never a pass (503). The verified subject must equal the session user and
 *     the e-mail must be verified.
 *  4. Local demo mode (Supabase NOT configured and not hosted): the one local
 *     user, same-origin still required. Hosted mode without an identity
 *     provider is refused.
 *
 * On success it returns the human principal and the `BrowserSessionProof` the
 * approval, autonomy and policy services demand.
 */
import type { NextRequest } from "next/server";
import type { Principal } from "@/lib/controlplane/types";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import type { BrowserSessionProof } from "@/lib/capabilities/types";
import { hostedMode } from "@/lib/hosted/config";
import { verifyRequestIdentity } from "@/lib/hosted/access/identity";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { currentRequest } from "@/lib/server/request";
import { requireWorkspace } from "@/lib/server/workspace";
import { HostedError } from "@/lib/hosted/contracts";

export interface BrowserCaller {
  principal: Principal;
  session: BrowserSessionProof;
  workspaceId: string;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;

function exactOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.origin === raw ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** The one origin a browser request may come from. */
export function expectedOrigin(req: NextRequest): string {
  return exactOrigin(process.env.ZENITH_PLATFORM_ORIGIN) ?? exactOrigin(process.env.ZENITH_AGENT_ORIGIN) ?? new URL(req.url).origin;
}

const browserRequired = (message: string): BrokerError =>
  new BrokerError("browser_session_required", message, "Use the signed-in Zenith web app; agent credentials cannot do this.");

/**
 * Assert that `req` is a person in a browser. Throws `BrokerError` (403/401/503)
 * otherwise. `mutation` demands the same-origin proof (every caller of this
 * module mutates; it is a parameter so a future read-only use is explicit).
 */
export async function assertBrowserSession(req: NextRequest, options: { mutation?: boolean } = {}): Promise<BrowserCaller> {
  const mutation = options.mutation ?? true;

  if (req.headers.has("authorization")) throw browserRequired("This action needs a person in the Zenith web app, not an agent credential.");
  if (req.headers.has("x-zenith-actor") || req.headers.has("x-zenith-actor-key")) throw browserRequired("This action needs a person in the Zenith web app, not the Navigator.");

  if (mutation) {
    if (req.headers.get("origin") !== expectedOrigin(req)) throw new BrokerError("browser_session_required", "Submit this from the Zenith web app (the request origin does not match).", "Use the web app at the Zenith origin.");
    const site = req.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin") throw new BrokerError("browser_session_required", "Submit this from the Zenith web app (cross-site requests are refused).", "Use the web app at the Zenith origin.");
  }

  const header = req.headers.get("x-zenith-workspace") ?? undefined;
  const query = req.nextUrl.searchParams.get("workspace") ?? undefined;
  if (header && query && header !== query) throw new BrokerError("invalid_request", "The workspace header and query parameter disagree.");
  const named = header ?? query;
  if (named !== undefined && !ID.test(named)) throw notFound();

  const state = currentRequest();
  if (isSupabaseConfigured()) {
    let identity;
    try {
      identity = await verifyRequestIdentity(req);
    } catch (error) {
      if (error instanceof HostedError && error.code === "sign_in_required") throw new BrokerError("unauthenticated", "Sign in to continue.", "Sign in, then repeat this.");
      throw new BrokerError("policy_unavailable", "Your identity could not be verified right now, so this was refused rather than allowed.", "Try again shortly.");
    }
    if (!identity.emailVerified || !state?.user || state.user.id !== identity.subject) {
      throw new BrokerError("unauthenticated", "Sign in with a verified account to continue.", "Sign in, then repeat this.");
    }
    const workspaceId = named ?? requireWorkspace().id;
    return {
      principal: { kind: "user", id: identity.subject, name: state.user.name || state.user.email },
      session: { method: "browser_session", subject: identity.subject, verifiedAtMs: Date.now() },
      workspaceId,
    };
  }

  if (hostedMode()) throw new BrokerError("policy_unavailable", "This deployment has no identity provider configured, so approvals and settings changes are refused.");
  // Local demo mode: one local user. Same-origin was still required above.
  return {
    principal: { kind: "user", id: "local", name: "You" },
    session: { method: "browser_session", subject: "local", verifiedAtMs: Date.now() },
    workspaceId: named ?? requireWorkspace().id,
  };
}
