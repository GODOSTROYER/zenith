/**
 * `POST /api/hosted/policy/admit` — admission for a runtime that is not this
 * process.
 *
 * The Cloudflare edge worker has no control authority, no session store and no
 * grant table. Rather than reimplement admission out there (where it would
 * drift, and where a bug would be a private app served to a stranger), it asks
 * this endpoint the same question the local gateway answers for itself, and
 * obeys the answer.
 *
 * Trust: a shared secret in `ZENITH_POLICY_SHARED_SECRET`, compared in
 * constant time. No secret configured means 503 — never an open endpoint, and
 * never a default. The endpoint counts the request against the app's daily
 * quota exactly as the local gateway does, because from the app's point of
 * view a request *was* served.
 *
 * The middleware's session gate must treat `/api/hosted/policy` as public
 * (`isPublicPath`): the caller is a worker holding a shared secret, not a
 * signed-in browser. See this workstream's report.
 *
 * Workstream W6 (hosted R3).
 */
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { HostedError, hostedErrorBody } from "@/lib/hosted/contracts";
import { decideAdmission } from "@/lib/hosted/gateway";
import { ensureBoot } from "@/lib/server/boot";

export const dynamic = "force-dynamic";

/** Bodies are tiny; anything larger is not a policy question. */
const MAX_BODY_BYTES = 8 * 1024;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });

const refuse = (error: HostedError): Response => {
  const { status, body } = hostedErrorBody(error);
  return json(status, body);
};

/**
 * Constant-time bearer comparison.
 *
 * Both sides are hashed first so `timingSafeEqual` always gets equal lengths —
 * comparing raw strings would throw on a length mismatch, and *that* is itself
 * a timing signal about how long the secret is.
 */
function bearerMatches(header: string | null, secret: string): boolean {
  const prefix = "bearer ";
  const raw = (header ?? "").trim();
  if (raw.toLowerCase().slice(0, prefix.length) !== prefix) return false;
  const presented = raw.slice(prefix.length).trim();
  const a = crypto.createHash("sha256").update(presented, "utf8").digest();
  const b = crypto.createHash("sha256").update(secret, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/** What a caller may ask about. Anything else in the body is ignored, not echoed. */
interface AdmitBody {
  host?: unknown;
  cookie?: unknown;
  method?: unknown;
  path?: unknown;
  origin?: unknown;
}

const str = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;

export async function POST(req: NextRequest): Promise<Response> {
  await ensureBoot();

  const secret = (process.env.ZENITH_POLICY_SHARED_SECRET ?? "").trim();
  if (!secret)
    return refuse(
      new HostedError(
        "policy_unavailable",
        "This control service is not configured to answer admission questions for another runtime.",
        {
          fix: "Set ZENITH_POLICY_SHARED_SECRET on the control service and give the same value to the edge worker, then try again.",
        }
      )
    );

  if (!bearerMatches(req.headers.get("authorization"), secret))
    return refuse(
      new HostedError("sign_in_required", "This endpoint needs the policy shared secret.", {
        fix: "Send `authorization: Bearer <ZENITH_POLICY_SHARED_SECRET>`. The value is the one configured on the control service.",
      })
    );

  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES)
    return refuse(
      new HostedError("body_too_large", "An admission question is larger than this endpoint will read.", {
        fix: `Send at most ${MAX_BODY_BYTES} bytes: the host, method, path, and optionally the app session cookie and origin.`,
      })
    );

  let body: AdmitBody;
  try {
    body = JSON.parse(raw || "{}") as AdmitBody;
  } catch {
    return refuse(
      new HostedError("invalid_input", "That admission question was not valid JSON.", {
        fix: 'Send `{ "host": "…", "method": "GET", "path": "/", "cookie": "…", "origin": "…" }`.',
      })
    );
  }

  const host = str(body.host, 253);
  const method = str(body.method, 16);
  const path = str(body.path, 2048);
  if (!host || !method || !path)
    return refuse(
      new HostedError("invalid_input", "An admission question needs a host, a method and a path.", {
        fix: 'Send `{ "host": "alpha.apps.example.com", "method": "GET", "path": "/" }` at minimum.',
      })
    );

  const decision = decideAdmission({
    host,
    method: method.toUpperCase(),
    path,
    cookie: str(body.cookie, 4096),
    origin: str(body.origin, 2048),
  });

  // A denial carries a status and a code and nothing else: no release, no
  // script name, no session. The caller has everything it needs to answer and
  // nothing it could leak.
  return json(200, decision, decision.retryAfter ? { "retry-after": String(decision.retryAfter) } : {});
}
