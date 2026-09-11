/**
 * `/api/hosted/policy/admit` — the same admission, answered for a runtime that
 * is not this process.
 *
 * The handler is called directly, because the middleware's session gate would
 * otherwise 401 an unauthenticated POST before it ran. That gate needs
 * `/api/hosted/policy` added to `isPublicPath`; the endpoint's own bearer check
 * is what actually protects it, and these tests are what pin that down.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { IDENTITIES, isolatedDataDir, removeDir } from "../_fixtures";
import {
  appHost,
  appOrigin,
  makeDoubles,
  provenance,
  resolved,
  seedActiveRelease,
  seedApp,
  seedArtifactRow,
  writeBuiltTree,
} from "./_helpers";

const DATA_DIR = isolatedDataDir("zenith-gateway-policy-");
process.env.ZENITH_POLICY_SHARED_SECRET = "a-long-shared-secret-for-the-edge";

const { closeAuthority, openAuthority } = await import("@/lib/hosted/authority");
const { FsArtifactStore } = await import("@/lib/hosted/artifacts");
const { hostedConfig } = await import("@/lib/hosted/config");
const { closeAllAppData } = await import("@/lib/hosted/data");
const { releaseScriptName, brokerScriptName, resetGatewayDeps, setGatewayDepsForTests } = await import(
  "@/lib/hosted/gateway"
);
const { POST } = await import("@/app/api/hosted/policy/admit/route");
const { ensureBoot } = await import("@/lib/server/boot");

const authority = openAuthority();
// The route boots the process on its first call. Doing it here instead means
// the outbox replay it schedules runs while this test's authority is still
// open, rather than after `afterAll` has closed it.
await ensureBoot();
await new Promise((resolve) => setTimeout(resolve, 0));
const store = new FsArtifactStore(hostedConfig().artifactDir);
const artifact = await store.put(writeBuiltTree(DATA_DIR), provenance("job-policy"));
seedArtifactRow(authority, artifact.digest, artifact.byteSize, artifact.fileCount);

const alpha = seedApp(authority, { slug: "alpha" });
seedApp(authority, { slug: "paused", state: "suspended" });
const release = seedActiveRelease(authority, alpha, artifact.digest);

const doubles = makeDoubles();
const SECRET = "a-long-shared-secret-for-the-edge";
const COOKIE = "policy-owner";

beforeEach(() => {
  process.env.ZENITH_POLICY_SHARED_SECRET = SECRET;
  resetGatewayDeps();
  setGatewayDepsForTests(doubles.deps);
  doubles.state.quotaAllowed = true;
  doubles.state.counted.length = 0;
  doubles.state.sessions.clear();
  doubles.state.sessions.set(
    COOKIE,
    resolved(alpha, { subject: IDENTITIES.owner.subject, email: IDENTITIES.owner.email, role: "owner" })
  );
});

afterEach(() => {
  process.env.ZENITH_POLICY_SHARED_SECRET = SECRET;
});

afterAll(() => {
  delete process.env.ZENITH_POLICY_SHARED_SECRET;
  resetGatewayDeps();
  closeAllAppData();
  closeAuthority();
  removeDir(DATA_DIR);
});

interface Decision {
  decision: "serve" | "deny";
  status: number;
  code?: string;
  release?: { id: string; digest: string; number: number; script: string };
  session?: { subject: string; email: string; role: string };
  reserved?: string;
  retryAfter?: number;
}

/** One question to the policy endpoint. */
function ask(
  body: Record<string, unknown>,
  opts: { bearer?: string | null } = {}
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.bearer !== null) headers.authorization = `Bearer ${opts.bearer ?? SECRET}`;
  return POST(
    new NextRequest("http://localhost:3400/api/hosted/policy/admit", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  );
}

const decisionOf = async (res: Response): Promise<Decision> => (await res.json()) as Decision;

describe("who may ask", () => {
  it("refuses a request with no bearer", async () => {
    const res = await ask({ host: appHost("alpha"), method: "GET", path: "/" }, { bearer: null });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("sign_in_required");
  });

  it("refuses a wrong bearer, including one that is a prefix of the real one", async () => {
    for (const wrong of ["nope", SECRET.slice(0, -1), `${SECRET}x`, ""]) {
      const res = await ask({ host: appHost("alpha"), method: "GET", path: "/" }, { bearer: wrong });
      expect(res.status, wrong).toBe(401);
    }
  });

  it("answers 503 when no secret is configured, rather than answering at all", async () => {
    delete process.env.ZENITH_POLICY_SHARED_SECRET;
    const res = await ask({ host: appHost("alpha"), method: "GET", path: "/" }, { bearer: "anything" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; fix: string } };
    expect(body.error.code).toBe("policy_unavailable");
    expect(body.error.fix).toContain("ZENITH_POLICY_SHARED_SECRET");
  });

  it("refuses a question that is not one", async () => {
    expect((await ask({ method: "GET", path: "/" })).status).toBe(400);
    expect((await ask({ host: appHost("alpha"), path: "/" })).status).toBe(400);
  });
});

describe("what it answers", () => {
  it("names the release script to dispatch for an admitted app path", async () => {
    const res = await ask({ host: appHost("alpha"), method: "GET", path: "/requests/1", cookie: COOKIE });
    expect(res.status).toBe(200);
    const decision = await decisionOf(res);
    expect(decision.decision).toBe("serve");
    expect(decision.release).toEqual({
      id: release.id,
      digest: artifact.digest,
      number: release.number,
      script: releaseScriptName("alpha", release.number, artifact.digest),
    });
    expect(decision.session).toEqual({
      subject: IDENTITIES.owner.subject,
      email: IDENTITIES.owner.email,
      role: "owner",
    });
  });

  it("names the broker script for a data path, and marks it reserved", async () => {
    const res = await ask({
      host: appHost("alpha"),
      method: "GET",
      path: "/_zenith/data/v1/requests",
      cookie: COOKIE,
    });
    const decision = await decisionOf(res);
    expect(decision.decision).toBe("serve");
    expect(decision.reserved).toBe("data.requests");
    expect(decision.release?.script).toBe(brokerScriptName("alpha"));
  });

  it("marks the sign-in page reserved and needs no session for it", async () => {
    const res = await ask({ host: appHost("alpha"), method: "GET", path: "/_zenith/auth/signin" });
    const decision = await decisionOf(res);
    expect(decision.decision).toBe("serve");
    expect(decision.reserved).toBe("auth.signin");
    expect(decision.session).toBeUndefined();
    expect(decision.release).toBeUndefined();
  });

  it("applies the same Origin rule to a mutation that the local gateway does", async () => {
    const good = await decisionOf(
      await ask({
        host: appHost("alpha"),
        method: "POST",
        path: "/_zenith/data/v1/requests",
        cookie: COOKIE,
        origin: appOrigin("alpha"),
      })
    );
    expect(good.decision).toBe("serve");

    const sibling = await decisionOf(
      await ask({
        host: appHost("alpha"),
        method: "POST",
        path: "/_zenith/data/v1/requests",
        cookie: COOKIE,
        origin: appOrigin("beta"),
      })
    );
    expect(sibling.decision).toBe("deny");
    expect(sibling.status).toBe(403);
    expect(sibling.code).toBe("csrf_rejected");
  });
});

describe("what a denial carries", () => {
  const denials: { what: string; body: Record<string, unknown>; status: number; code: string }[] = [
    { what: "an unknown host", body: { host: "nosuch.apps.localhost:3400", method: "GET", path: "/" }, status: 404, code: "unknown_host" },
    { what: "the control origin", body: { host: "localhost:3400", method: "GET", path: "/" }, status: 404, code: "unknown_host" },
    { what: "a suspended app", body: { host: appHost("paused"), method: "GET", path: "/" }, status: 423, code: "suspended" },
    { what: "no session", body: { host: appHost("alpha"), method: "GET", path: "/" }, status: 401, code: "sign_in_required" },
    { what: "another app's session", body: { host: appHost("alpha"), method: "GET", path: "/", cookie: "unknown-cookie" }, status: 401, code: "sign_in_required" },
    { what: "an unknown reserved path", body: { host: appHost("alpha"), method: "GET", path: "/_zenith/nope" }, status: 404, code: "not_found" },
  ];

  for (const { what, body, status, code } of denials) {
    it(`denies ${what} without naming a release`, async () => {
      const decision = await decisionOf(await ask(body));
      expect(decision.decision).toBe("deny");
      expect(decision.status).toBe(status);
      expect(decision.code).toBe(code);
      expect(decision.release).toBeUndefined();
      expect(decision.session).toBeUndefined();
    });
  }

  it("passes the quota's retry-after through to the caller", async () => {
    doubles.state.quotaAllowed = false;
    const res = await ask({ host: appHost("alpha"), method: "GET", path: "/", cookie: COOKIE });
    const decision = await decisionOf(res);
    expect(decision.decision).toBe("deny");
    expect(decision.status).toBe(429);
    expect(decision.retryAfter).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toBe(String(decision.retryAfter));
  });

  it("counts every request that resolved to a known app, exactly as the gateway does", async () => {
    await ask({ host: appHost("alpha"), method: "GET", path: "/" });
    await ask({ host: "nosuch.apps.localhost:3400", method: "GET", path: "/" });
    expect(doubles.state.counted).toEqual([alpha.id]);
  });
});
