/**
 * The /api/hosted access routes, driven directly with a NextRequest.
 *
 * Two things are being proved here that no unit test can prove:
 *
 *  1. **An outsider can accept an invitation.** The person a hosted app is
 *     shared with may hold no workspace membership at all, and the ordinary
 *     request path refuses a non-member. This handler must not go anywhere near
 *     `requireWorkspace()`, and the test signs in as somebody who belongs to
 *     nothing to say so.
 *  2. **Identity is checked live, and unavailable is not a pass.** The
 *     provider double here is the *real* `supabaseSessionAuthority` over a fake
 *     client, so the classification under test is the shipping one: a provider
 *     that cannot be reached becomes 503, never an admitted request.
 */
import { afterEach, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isolatedDataDir, removeDir } from "../_fixtures";
import type { SessionUser } from "@/lib/auth/session";

const dataDir = isolatedDataDir("zenith-access-routes-");
process.env.ZENITH_SECRET_KEY = "4".repeat(64);
// Tenancy only exists once auth does; without keys every caller is the one
// local demo user who is a member of everything.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";

const session = vi.hoisted(() => ({ user: null as SessionUser | null }));
vi.mock("@/lib/supabase/route", () => ({
  sessionUserFromRequest: async () => session.user,
}));

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { createInvite, setSessionAuthorityForTests, supabaseSessionAuthority } = await import(
  "@/lib/hosted/access"
);
const { IDENTITIES, seedApp, seedGrant, uuid } = await import("./_helpers");

const grantsRoute = await import("@/app/api/hosted/apps/[appId]/grants/route");
const grantRoute = await import("@/app/api/hosted/apps/[appId]/grants/[grantId]/route");
const invitesRoute = await import("@/app/api/hosted/apps/[appId]/invites/route");
const inviteRoute = await import("@/app/api/hosted/apps/[appId]/invites/[inviteId]/route");
const resendRoute = await import("@/app/api/hosted/apps/[appId]/invites/[inviteId]/resend/route");
const launchRoute = await import("@/app/api/hosted/apps/[appId]/launch/route");
const acceptRoute = await import("@/app/api/hosted/invites/accept/route");
const terminateRoute = await import("@/app/api/hosted/session/terminate/route");

const a = openAuthority();

/* ------------------------------ the doubles ------------------------------- */

interface ProviderState {
  user: { id: string; email: string; email_confirmed_at: string | null } | null;
  error: { message?: string; status?: number } | null;
  throws: Error | null;
}

const provider: ProviderState = { user: null, error: null, throws: null };

// The shipping authority over a fake client: the mapping from a provider answer
// to a refusal is the code under test, not something this file re-implements.
setSessionAuthorityForTests(
  await supabaseSessionAuthority({
    createClient: () => ({
      auth: {
        async getUser() {
          if (provider.throws) throw provider.throws;
          return { data: { user: provider.user }, error: provider.error };
        },
      },
    }),
  })
);

/** Sign in as somebody, on both the session and the provider. */
const signIn = (who: { subject: string; email: string; name: string }, verifiedEmail = true): void => {
  session.user = { id: who.subject, email: who.email, name: who.name };
  provider.user = {
    id: who.subject,
    email: who.email,
    email_confirmed_at: verifiedEmail ? "2026-01-01T00:00:00.000Z" : null,
  };
  provider.error = null;
  provider.throws = null;
};

beforeEach(async () => {
  signIn(IDENTITIES.owner);
});

afterEach(async () => {
  session.user = null;
  provider.user = null;
  provider.error = null;
  provider.throws = null;
});

afterAll(async () => {
  await setSessionAuthorityForTests(null);
  closeAuthority();
  removeDir(dataDir);
});

/* -------------------------------- plumbing -------------------------------- */

type Handler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> }
) => Promise<Response>;

const call = (
  handler: unknown,
  url: string,
  params: Record<string, string> = {},
  init: { method?: string; body?: unknown } = {}
): Promise<Response> => {
  const request = new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    ...(init.body === undefined
      ? {}
      : { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } }),
  });
  return (handler as Handler)(request, { params: Promise.resolve(params) });
};

interface ErrorBody {
  error: { code: string; message: string; fix?: string };
}

const errorOf = async (res: Response): Promise<ErrorBody["error"]> =>
  ((await res.json()) as ErrorBody).error;

const app = async (slug: string) => {
  const record = await seedApp(a, { slug, name: `App ${slug}` });
  await seedGrant(a, record.id, IDENTITIES.owner, "owner");
  return record;
};

/* --------------------------------- tests ---------------------------------- */

describe("owner-only routes", () => {
  it("lets an owner read and change the access list", async () => {
    const target = await app("routes-owner");
    const list = await call(grantsRoute.GET, `/api/hosted/apps/${target.id}/grants`, { appId: target.id });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(((await list.json()) as { grants: unknown[] }).grants).toHaveLength(1);

    const created = await call(
      grantsRoute.POST,
      `/api/hosted/apps/${target.id}/grants`,
      { appId: target.id },
      { method: "POST", body: { subject: IDENTITIES.viewer.subject, email: IDENTITIES.viewer.email, role: "viewer" } }
    );
    expect(created.status).toBe(201);
    const grantId = ((await created.json()) as { grant: { id: string } }).grant.id;

    const patched = await call(
      grantRoute.PATCH,
      `/api/hosted/apps/${target.id}/grants/${grantId}`,
      { appId: target.id, grantId },
      { method: "PATCH", body: { role: "editor" } }
    );
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { grant: { role: string } }).grant.role).toBe("editor");

    const deleted = await call(
      grantRoute.DELETE,
      `/api/hosted/apps/${target.id}/grants/${grantId}`,
      { appId: target.id, grantId },
      { method: "DELETE", body: { reason: "left the project" } }
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json()) as { grant: { state: string } }).toMatchObject({
      grant: { state: "revoked" },
    });
  });

  it("refuses an editor and a stranger alike, in the hosted envelope", async () => {
    const target = await app("routes-refuse");
    await seedGrant(a, target.id, IDENTITIES.editor, "editor");

    signIn(IDENTITIES.editor);
    const asEditor = await call(grantsRoute.GET, `/api/hosted/apps/${target.id}/grants`, {
      appId: target.id,
    });
    signIn(IDENTITIES.stranger);
    const asStranger = await call(grantsRoute.GET, `/api/hosted/apps/${target.id}/grants`, {
      appId: target.id,
    });

    expect(asEditor.status).toBe(403);
    expect(asStranger.status).toBe(403);
    expect(asEditor.headers.get("cache-control")).toBe("no-store");
    const editorError = await errorOf(asEditor);
    expect(editorError).toEqual(await errorOf(asStranger));
    expect(editorError.code).toBe("forbidden");
    expect(editorError.fix).toBeTruthy();
  });

  it("refuses to remove the app's only owner, with 409 and a way forward", async () => {
    const target = await app("routes-last-owner");
    const owner = (await a.repos.grants.listByApp(target.id))[0];
    const res = await call(
      grantRoute.DELETE,
      `/api/hosted/apps/${target.id}/grants/${owner.id}`,
      { appId: target.id, grantId: owner.id },
      { method: "DELETE" }
    );
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe("conflict");
    expect(error.fix).toContain("owner");
    expect((await a.repos.grants.get(owner.id))?.state).toBe("active");
  });

  it("refuses a body that is not valid", async () => {
    const target = await app("routes-bad-body");
    const res = await call(
      grantsRoute.POST,
      `/api/hosted/apps/${target.id}/grants`,
      { appId: target.id },
      { method: "POST", body: { subject: uuid(), email: "someone@example.test", role: "admin" } }
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_input");
  });
});

describe("invitations over HTTP", () => {
  it("answers 201 with the link once, then resends and revokes it", async () => {
    const target = await app("routes-invites");
    const created = await call(
      invitesRoute.POST,
      `/api/hosted/apps/${target.id}/invites`,
      { appId: target.id },
      { method: "POST", body: { email: IDENTITIES.stranger.email, role: "viewer" } }
    );
    expect(created.status).toBe(201);
    const issued = (await created.json()) as {
      invite: { id: string };
      delivery: { state: string };
      acceptUrl: string;
    };
    expect(issued.acceptUrl).toContain("/apps/accept?token=");

    const listed = await call(invitesRoute.GET, `/api/hosted/apps/${target.id}/invites`, {
      appId: target.id,
    });
    const invites = ((await listed.json()) as { invites: unknown[] }).invites;
    expect(invites).toHaveLength(1);

    const resent = await call(
      resendRoute.POST,
      `/api/hosted/apps/${target.id}/invites/${issued.invite.id}/resend`,
      { appId: target.id, inviteId: issued.invite.id },
      { method: "POST" }
    );
    expect(resent.status).toBe(201);
    const replacement = (await resent.json()) as { invite: { id: string } };
    expect(replacement.invite.id).not.toBe(issued.invite.id);

    const revoked = await call(
      inviteRoute.DELETE,
      `/api/hosted/apps/${target.id}/invites/${replacement.invite.id}`,
      { appId: target.id, inviteId: replacement.invite.id },
      { method: "DELETE" }
    );
    expect(revoked.status).toBe(200);
    expect((await revoked.json()) as { invite: { state: string } }).toMatchObject({
      invite: { state: "revoked" },
    });
  });
});

describe("accepting an invitation as an outsider", () => {
  it("works for a signed-in person who belongs to no workspace at all", async () => {
    const target = await app("routes-accept");
    const issued = await createInvite(
      target.id,
      { email: IDENTITIES.stranger.email, role: "editor" },
      IDENTITIES.owner.subject
    );
    const token = new URL(issued.acceptUrl).searchParams.get("token") as string;

    signIn(IDENTITIES.stranger);
    // Nothing in the store makes this person a member of anything.
    expect(await a.repos.grants.activeFor(target.id, IDENTITIES.stranger.subject)).toBeNull();

    const res = await call(acceptRoute.POST, "/api/hosted/invites/accept", {}, {
      method: "POST",
      body: { token },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      app: { id: string; slug: string; name: string };
      grant: { role: string; state: string };
      launchUrl: string;
    };
    expect(body.app).toEqual({ id: target.id, slug: target.slug, name: target.name });
    expect(body.grant).toMatchObject({ role: "editor", state: "active" });
    expect(body.launchUrl).toBe(`/api/hosted/apps/${target.id}/launch`);
  });

  it("refuses an unconfirmed address with 403 and grants nothing", async () => {
    const target = await app("routes-accept-unverified");
    const issued = await createInvite(
      target.id,
      { email: IDENTITIES.viewer.email, role: "viewer" },
      IDENTITIES.owner.subject
    );
    const token = new URL(issued.acceptUrl).searchParams.get("token") as string;

    signIn(IDENTITIES.viewer, false);
    const res = await call(acceptRoute.POST, "/api/hosted/invites/accept", {}, {
      method: "POST",
      body: { token },
    });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("forbidden");
    expect(await a.repos.grants.activeFor(target.id, IDENTITIES.viewer.subject)).toBeNull();
    expect((await a.repos.invites.get(issued.invite.id))?.state).toBe("pending");
  });
});

describe("launching an app", () => {
  it("answers a redirect for POST and a 303 for a plain link", async () => {
    const target = await app("routes-launch");
    await seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    signIn(IDENTITIES.viewer);

    const posted = await call(
      launchRoute.POST,
      `/api/hosted/apps/${target.id}/launch`,
      { appId: target.id },
      { method: "POST", body: { state: "state-abcdef0123456789" } }
    );
    expect(posted.status).toBe(200);
    const redirect = ((await posted.json()) as { redirect: string }).redirect;
    expect(new URL(redirect).pathname).toBe("/_zenith/auth/callback");

    const linked = await call(
      launchRoute.GET,
      `/api/hosted/apps/${target.id}/launch?state=state-abcdef0123456789`,
      { appId: target.id }
    );
    expect(linked.status).toBe(303);
    expect(linked.headers.get("cache-control")).toBe("no-store");
    expect(new URL(linked.headers.get("location") as string).pathname).toBe("/_zenith/auth/callback");
  });

  it("refuses a stranger with 403 and mints nothing", async () => {
    const target = await app("routes-launch-stranger");
    signIn(IDENTITIES.stranger);
    const res = await call(
      launchRoute.POST,
      `/api/hosted/apps/${target.id}/launch`,
      { appId: target.id },
      { method: "POST", body: { state: "state-abcdef0123456789" } }
    );
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("forbidden");
  });
});

describe("when the identity provider cannot be reached", () => {
  it("answers 503 rather than admitting the request — on accept and on launch", async () => {
    const target = await app("routes-outage");
    await seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    const issued = await createInvite(
      target.id,
      { email: IDENTITIES.stranger.email, role: "viewer" },
      IDENTITIES.owner.subject
    );
    const token = new URL(issued.acceptUrl).searchParams.get("token") as string;

    signIn(IDENTITIES.stranger);
    provider.throws = new Error("connect ECONNREFUSED 127.0.0.1:54321");

    const accepted = await call(acceptRoute.POST, "/api/hosted/invites/accept", {}, {
      method: "POST",
      body: { token },
    });
    expect(accepted.status).toBe(503);
    expect((await errorOf(accepted)).code).toBe("policy_unavailable");

    signIn(IDENTITIES.viewer);
    provider.throws = new Error("connect ECONNREFUSED 127.0.0.1:54321");
    const launched = await call(
      launchRoute.POST,
      `/api/hosted/apps/${target.id}/launch`,
      { appId: target.id },
      { method: "POST", body: { state: "state-abcdef0123456789" } }
    );
    expect(launched.status).toBe(503);
    expect((await errorOf(launched)).code).toBe("policy_unavailable");

    // Nothing was admitted, and nothing was written.
    expect((await a.repos.invites.get(issued.invite.id))?.state).toBe("pending");
    expect(await a.repos.grants.activeFor(target.id, IDENTITIES.stranger.subject)).toBeNull();
  });

  it("answers 401 only when the provider positively says there is no session", async () => {
    const target = await app("routes-signed-out");
    await seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    signIn(IDENTITIES.viewer);
    provider.user = null;
    provider.error = { message: "Auth session missing!", status: 400 };

    const res = await call(
      launchRoute.POST,
      `/api/hosted/apps/${target.id}/launch`,
      { appId: target.id },
      { method: "POST", body: { state: "state-abcdef0123456789" } }
    );
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("sign_in_required");
  });

  it("treats a rate limit and a 5xx as unavailable, never as a denial to route around", async () => {
    const target = await app("routes-rate-limited");
    await seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    signIn(IDENTITIES.viewer);
    for (const status of [429, 500, 503]) {
      provider.user = null;
      provider.error = { message: "upstream", status };
      const res = await call(
        launchRoute.POST,
        `/api/hosted/apps/${target.id}/launch`,
        { appId: target.id },
        { method: "POST", body: { state: "state-abcdef0123456789" } }
      );
      expect(res.status).toBe(503);
    }
  });
});

describe("sign-out", () => {
  it("terminates the caller's app sessions and says how many", async () => {
    const target = await app("routes-signout");
    const grant = await seedGrant(a, target.id, IDENTITIES.viewer, "viewer");
    await a.tx((repos) =>
      repos.sessions.insert({
        id: "f".repeat(64),
        appId: target.id,
        subject: IDENTITIES.viewer.subject,
        grantId: grant.id,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
    );

    signIn(IDENTITIES.viewer);
    const res = await call(terminateRoute.POST, "/api/hosted/session/terminate", {}, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { terminated: number }).toMatchObject({ terminated: 1 });
    expect((await a.repos.sessions.get("f".repeat(64)))?.terminatedReason).toBe("signed_out");
  });

  it("refuses a caller with no session at all", async () => {
    session.user = null;
    const res = await call(terminateRoute.POST, "/api/hosted/session/terminate", {}, { method: "POST" });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("sign_in_required");
  });
});
