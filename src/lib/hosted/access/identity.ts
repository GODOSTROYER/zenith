/**
 * The authoritative identity check — R3-10, gap G13.
 *
 * Everywhere else in this product a signed-in caller is resolved with
 * `getClaims()`: a signature check over a JWT the browser already holds. That
 * is right for reading your own dashboard and wrong for anything that grants,
 * revokes or opens access, because a JWT stays cryptographically valid until it
 * expires — including after the session behind it was signed out or an
 * administrator disabled the account.
 *
 * So the grant-sensitive endpoints ask the identity provider itself:
 * `auth.getUser()`, a live round trip that fails for a session the provider no
 * longer recognises.
 *
 * The failure rule is the whole point. **Unavailable is never a pass.** No
 * provider configured, a network error, a 5xx or a rate limit all answer
 * `policy_unavailable` (503). Only a provider that positively said "this is not
 * a signed-in caller" answers `sign_in_required` (401). There is no branch in
 * this file that returns an identity it did not get from the provider.
 *
 * ponytail: every grant-sensitive request costs one provider round trip, and
 * none of them is cached. That is the correct default — the whole point is that
 * a terminated session stops working immediately — and the upgrade path, if the
 * latency ever matters, is a very short positive cache keyed on the access
 * token with a ceiling in single-digit seconds. A negative answer must never be
 * cached at all.
 *
 * Workstream W5 (hosted R3).
 */
import { createServerClient } from "@supabase/ssr";
import type { NextRequest } from "next/server";
import { HostedError, type SessionAuthority, type VerifiedIdentity } from "@/lib/hosted/contracts";
import { SUPABASE_PUBLIC_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/supabase/env";

/** The user shape this module reads out of a provider response. */
export interface ProviderUser {
  id: string;
  email?: string | null;
  /** Set by the provider when the address has been confirmed. */
  email_confirmed_at?: string | null;
}

/** The provider error shape this module classifies. */
export interface ProviderError {
  message?: string;
  status?: number;
}

/** The slice of a Supabase client this module uses. Kept minimal so a test can stand it up. */
export interface IdentityClient {
  auth: {
    getUser(jwt?: string): Promise<{
      data: { user: ProviderUser | null } | null;
      error: ProviderError | null;
    }>;
    getClaims?: () => Promise<unknown>;
  };
}

/** Builds a request-scoped provider client. Injected by tests; never mocked in production. */
export type IdentityClientFactory = (req: NextRequest | null) => IdentityClient;

/** A `SessionAuthority` that can also verify the caller of a specific request. */
export interface RequestIdentityAuthority extends SessionAuthority {
  /** Verify whoever is calling `req`, from the cookies on that request. */
  verifyRequest(req: NextRequest): Promise<VerifiedIdentity>;
}

export const NO_IDENTITY_PROVIDER =
  "This build has no identity provider configured, so the caller of a grant-sensitive request cannot be verified.";

const unavailable = (message: string, detail?: string): HostedError =>
  new HostedError("policy_unavailable", message, {
    fix: "This request was refused rather than allowed on an unverified identity. Try again; if it persists, check that the identity provider is reachable from this server.",
    details: detail ? { detail } : undefined,
  });

const signInRequired = (): HostedError =>
  new HostedError("sign_in_required", "You are not signed in, or your session has ended.", {
    fix: "Sign in to Zenith again, then repeat what you were doing.",
  });

/**
 * The default factory: a request-scoped client over the request's cookies, the
 * same construction `@/lib/supabase/route` uses. Writes are dropped — the
 * middleware owns session refresh, and a verification must not mint cookies.
 */
const supabaseClientFactory: IdentityClientFactory = (req) => {
  if (!isSupabaseConfigured()) throw unavailable(NO_IDENTITY_PROVIDER);
  // The SDK's response types are unions this module deliberately does not
  // depend on; `IdentityClient` is the contract it actually uses.
  return createServerClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, {
    cookies: {
      getAll() {
        return req ? req.cookies.getAll() : [];
      },
      setAll() {
        /* verification never writes cookies */
      },
    },
  }) as unknown as IdentityClient;
};

/**
 * The Supabase-backed session authority.
 *
 * `verify({ accessToken })` checks a bearer token; `verifyRequest(req)` checks
 * whoever the request's cookies claim to be. Both go to the provider.
 */
export function supabaseSessionAuthority(
  opts: { createClient?: IdentityClientFactory } = {}
): RequestIdentityAuthority {
  const factory = opts.createClient ?? supabaseClientFactory;
  const check = async (req: NextRequest | null, accessToken?: string): Promise<VerifiedIdentity> => {
    let client: IdentityClient;
    try {
      client = factory(req);
    } catch (err) {
      if (err instanceof HostedError) throw err;
      throw unavailable(NO_IDENTITY_PROVIDER, message(err));
    }

    let answer: { data: { user: ProviderUser | null } | null; error: ProviderError | null };
    try {
      answer = await client.auth.getUser(accessToken);
    } catch (err) {
      // A thrown error is a failure to *ask* — DNS, TLS, a timeout. Refuse.
      throw unavailable(
        "The identity provider could not be reached, so this request was refused rather than allowed on an unverified session.",
        message(err)
      );
    }

    if (answer.error) throw classify(answer.error);
    const user = answer.data?.user;
    if (!user || !user.id) throw signInRequired();

    return {
      subject: user.id,
      email: (user.email ?? "").trim().toLowerCase(),
      emailVerified: !!user.email_confirmed_at,
      sessionId: await sessionIdOf(client),
    };
  };

  return {
    verify: (input) => check(null, input.accessToken),
    verifyRequest: (req) => check(req),
  };
}

/* ------------------------------- injection -------------------------------- */

type IdentityGlobal = typeof globalThis & { __zenithIdentityAuthority?: RequestIdentityAuthority };

/**
 * Replace the identity authority for a test, or pass null to restore the real
 * one. Nothing in production calls this: the only injection point is here, so
 * there is one place to look when asking "could this have been faked?".
 */
export function setSessionAuthorityForTests(authority: RequestIdentityAuthority | null): void {
  const g = globalThis as IdentityGlobal;
  if (authority) g.__zenithIdentityAuthority = authority;
  else delete g.__zenithIdentityAuthority;
}

/** The authority in force: the injected one in a test, otherwise Supabase. */
export const sessionAuthority = (): RequestIdentityAuthority =>
  (globalThis as IdentityGlobal).__zenithIdentityAuthority ?? supabaseSessionAuthority();

/** Live identity check against the provider (getUser), never a bare claim read. */
export async function verifyRequestIdentity(req: NextRequest): Promise<VerifiedIdentity> {
  return sessionAuthority().verifyRequest(req);
}

/* -------------------------------- internals ------------------------------- */

const message = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * A provider error is a denial only when the provider decided one.
 *
 * 4xx below 429 means "this caller is not signed in"; everything else — no
 * status at all, a rate limit, a 5xx — means the answer is unknown, and an
 * unknown answer is a refusal, not an admission.
 */
function classify(error: ProviderError): HostedError {
  const status = error.status;
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 429)
    return signInRequired();
  return unavailable(
    "The identity provider did not answer, so this request was refused rather than allowed on an unverified session.",
    error.message
  );
}

/**
 * The provider's session id, when the client can produce one.
 *
 * Best effort and never load-bearing: `getUser` does not return it, and no
 * decision in this module depends on it. A failure here leaves the field
 * undefined rather than turning a verified identity into a refusal.
 */
async function sessionIdOf(client: IdentityClient): Promise<string | undefined> {
  if (typeof client.auth.getClaims !== "function") return undefined;
  try {
    const answer = (await client.auth.getClaims()) as {
      data?: { claims?: Record<string, unknown> } | null;
    } | null;
    const id = answer?.data?.claims?.session_id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}
