/**
 * The HTTP edge of app access: one wrapper, one body reader, two ways to name
 * the caller.
 *
 * `hostedRoute` sits on top of `route()` so hosted handlers keep everything
 * that wrapper provides — boot, request id, workspace resolution, `no-store` —
 * and additionally render a `HostedError` as the hosted envelope
 * (`{ error: { code, message, fix?, details? } }`) with the code's status from
 * `HOSTED_STATUS`. Anything that is not a `HostedError` is left to
 * `errorResponse`, which is where a bug belongs.
 *
 * The two ways to name a caller are not interchangeable:
 *
 *  - `signedInUser()` is the resolved session (a verified JWT). Enough to
 *    *read* an app's access list.
 *  - `verifiedIdentity(req)` is a live round trip to the identity provider.
 *    Required before anything that grants, revokes, invites, accepts or opens
 *    an app — R3-10. A session that was signed out still has a valid-looking
 *    JWT, and only the provider knows that.
 *
 * Note this file is deliberately **not** re-exported from `access/index.ts`:
 * the gateway and the job runner import that barrel, and neither should be
 * dragging the /api request layer in behind it.
 *
 * Workstream W5 (hosted R3).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  HostedError,
  hostedErrorBody,
  isHostedError,
  type AppGrant,
  type VerifiedIdentity,
} from "@/lib/hosted/contracts";
import { currentRequest, route } from "@/lib/server/context";
import type { SessionUser } from "@/lib/auth/session";
import { requireAppRole } from "./grants";
import { verifyRequestIdentity } from "./identity";

/** JSON with the hosted conventions: `no-store`, and the caller's chosen status. */
export const hostedJson = (data: unknown, status = 200): NextResponse =>
  NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });

/**
 * Wrap a hosted handler. Same contract as `route()`, plus the hosted error
 * envelope.
 */
export function hostedRoute<P extends Record<string, string> = Record<string, string>>(
  handler: (req: NextRequest, params: P) => Promise<unknown>
) {
  return route<P>(async (req, params) => {
    try {
      return await handler(req, params);
    } catch (err) {
      if (!isHostedError(err)) throw err;
      const { status, body } = hostedErrorBody(err);
      return hostedJson(body, status);
    }
  });
}

/**
 * The signed-in caller, or `sign_in_required`.
 *
 * Read from the state `route()` already resolved — deliberately **not** from
 * `resolveActor()` or `requireWorkspace()`. Someone invited to an app may hold
 * no workspace membership at all, and accepting their invitation must not
 * require one.
 */
export function signedInUser(): SessionUser {
  const user = currentRequest()?.user;
  if (!user)
    throw new HostedError("sign_in_required", "You are not signed in.", {
      fix: "Sign in to Zenith and try again.",
    });
  return user;
}

/** The caller, verified live against the identity provider. Unavailable is never a pass. */
export const verifiedIdentity = (req: NextRequest): Promise<VerifiedIdentity> =>
  verifyRequestIdentity(req);

/** Owner check for a read: the resolved session is enough to look at the access list. */
export const signedInOwner = (appId: string): { user: SessionUser; grant: AppGrant } => {
  const user = signedInUser();
  return { user, grant: requireAppRole(appId, user.id, "owner") };
};

/** Owner check for a mutation: the provider is asked who is calling, and its answer is used. */
export async function verifiedOwner(
  req: NextRequest,
  appId: string
): Promise<{ identity: VerifiedIdentity; grant: AppGrant }> {
  const identity = await verifyRequestIdentity(req);
  return { identity, grant: requireAppRole(appId, identity.subject, "owner") };
}

/**
 * Parse and validate a JSON body, refusing with `invalid_input` and the field
 * that was wrong rather than a stack trace.
 */
export async function readJsonBody<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HostedError("invalid_input", "This request needs a JSON body.", {
      fix: 'Send `content-type: application/json` and a JSON object, for example {"role":"viewer"}.',
    });
  }
  return readValue(schema, raw);
}

/**
 * The same, for a request whose body is optional — a `DELETE` that may carry
 * `{ reason }` and may carry nothing at all. A missing or empty body validates
 * as `{}`; a malformed one is still `invalid_input`.
 */
export async function readOptionalJsonBody<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T> {
  const text = (await req.text()).trim();
  if (!text) return readValue(schema, {});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HostedError("invalid_input", "This request's body is not valid JSON.", {
      fix: "Send a JSON object, or no body at all.",
    });
  }
  return readValue(schema, raw);
}

function readValue<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({
    field: issue.path.join(".") || "(body)",
    problem: issue.message,
  }));
  throw new HostedError("invalid_input", `This request body is not valid: ${issues[0].problem}`, {
    fix: `Correct ${issues.map((i) => i.field).join(", ")} and send the request again.`,
    details: { issues },
  });
}

/** The app role vocabulary, as a body-level schema. */
export const RoleSchema = z.enum(["owner", "editor", "viewer"]);
