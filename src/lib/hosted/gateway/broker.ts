/**
 * The fixed broker's HTTP surface: `/_zenith/data/v1/requests` and
 * `/_zenith/data/v1/requests/:id`.
 *
 * Nothing an app publishes runs here. The app's JavaScript calls these paths
 * from the browser and the platform answers them, which is what makes "the
 * editable code path holds no data capability" (PLAN-R3 gate 4) true rather
 * than aspirational.
 *
 * Three defences, in this order, before the per-app store is touched:
 *
 *  1. **Origin.** A mutation must carry this app's own origin, exactly. A
 *     sibling app on the same domain is a different origin and is refused.
 *  2. **Role.** A viewer's POST or PATCH is refused *here*, so the store is
 *     never called at all — the store enforces the same rule as its own second
 *     line, and `gatewayTelemetry.brokerInvoked` proves which one fired.
 *  3. **Size.** The body is read through the quota module's bounded reader, so
 *     a 40 MB paste is a 413 rather than 40 MB of resident memory.
 */
import type { NextRequest } from "next/server";
import { hostedConfig } from "@/lib/hosted/config";
import {
  APP_ROLE_RANK,
  DEFAULT_LIMITS,
  HostedError,
  TRACKER_LIMITS,
  type DataContext,
} from "@/lib/hosted/contracts";
import type {
  CreateRequestInput,
  ListRequestsInput,
  UpdateRequestInput,
} from "@/lib/hosted/data";
import { csrfRejected, noteAccessDenied, type AdmittedRequest, type ReservedRoute } from "./admission";
import { gatewayDeps } from "./deps";
import { methodNotAllowed, respondWithError } from "./errors";
import { gatewayJson } from "./guard";
import { noteBrokerInvoked } from "./telemetry";

/** Methods the collection and the item answer. Anything else is a 405 with `allow`. */
const COLLECTION_METHODS = ["GET", "POST"] as const;
const ITEM_METHODS = ["GET", "PATCH"] as const;

/**
 * The same-origin check every state-changing request must pass.
 *
 * `Origin` is compared to `<scheme>://<host>` built from this request's own
 * Host header and the configured app scheme — scheme, host and port all have
 * to match, case-insensitively. `Sec-Fetch-Site`, when the browser sends it,
 * must say `same-origin` or `none`; a browser that sends `cross-site` has
 * already told us what this is.
 *
 * `requireJsonContentType` is on for anything whose body the gateway parses.
 * It is off for sign-out, which has no body worth reading: requiring a content
 * type there would only refuse a request the Origin check already decided.
 */
export function assertSameOriginMutation(
  req: NextRequest,
  host: string,
  opts: { requireJsonContentType: boolean }
): void {
  const expected = `${hostedConfig().ZENITH_APP_SCHEME}://${host.toLowerCase()}`;
  const origin = (req.headers.get("origin") ?? "").trim().toLowerCase();
  if (origin !== expected) throw csrfRejected();

  const site = (req.headers.get("sec-fetch-site") ?? "").trim().toLowerCase();
  if (site !== "" && site !== "same-origin" && site !== "none") throw csrfRejected();

  if (!opts.requireJsonContentType) return;
  const type = (req.headers.get("content-type") ?? "").trim().toLowerCase();
  if (!type.startsWith("application/json"))
    throw new HostedError("invalid_input", "A change has to be sent as application/json.", {
      fix: 'Send the request with the header `content-type: application/json` and a JSON body.',
    });
}

/** The store context one admitted request writes under. Never assembled from the body. */
export function dataContextOf(admitted: AdmittedRequest): DataContext {
  return {
    appId: admitted.app.id,
    subject: admitted.session.subject,
    email: admitted.grant.email,
    role: admitted.grant.role,
    releaseId: admitted.release.id,
  };
}

/**
 * The list query, taken from the URL and nothing else.
 *
 * Only the four parameters the contract names are copied across; anything else
 * in the query string is dropped rather than forwarded, because
 * `ListRequestsQuery` is `.strict()` and would answer an unknown parameter
 * with a 400 that blames the caller for a link they may not have written.
 */
function listQuery(url: URL): ListRequestsInput {
  const query: Record<string, string> = {};
  for (const key of ["limit", "cursor", "status", "category"]) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "") query[key] = value;
  }
  // The store parses this against the frozen schema before it reads a row.
  return query as ListRequestsInput;
}

/** Fire-and-forget event recording; a failed row never changes the answer. */
async function note(
  admitted: AdmittedRequest,
  event: "record.created" | "record.updated" | "record.conflict",
  outcome: "ok" | "error",
  logicalId?: string
): Promise<void> {
  try {
    await gatewayDeps().recordEvent({
      event,
      workspaceId: admitted.app.workspaceId,
      appId: admitted.app.id,
      subject: admitted.session.subject,
      releaseId: admitted.release.id,
      outcome,
      logicalId,
    });
  } catch {
    /* observation only */
  }
}

/** The write id a body claims, for event de-duplication. Never trusted for anything else. */
const writeIdOf = (body: unknown): string | undefined => {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { writeId?: unknown }).writeId;
  return typeof value === "string" ? value : undefined;
};

/**
 * Answer one broker request for an already-admitted caller.
 *
 * `admitted` is the product of steps 1–8; this function never re-derives the
 * app, the role or the release from anything on the wire.
 */
export async function handleBroker(
  req: NextRequest,
  route: ReservedRoute,
  admitted: AdmittedRequest
): Promise<Response> {
  const method = req.method.toUpperCase();
  const item = route.recordId !== undefined;
  const allowed: readonly string[] = item ? ITEM_METHODS : COLLECTION_METHODS;
  const releaseId = admitted.release.id;

  if (!allowed.includes(method))
    return methodNotAllowed(allowed, {
      wantsHtml: false,
      releaseId,
      what: item ? "An equipment request" : "The equipment request list",
    });

  const ctx = dataContextOf(admitted);
  // Lazy on purpose: a refused request must not so much as open the app's
  // database file, so the store is resolved only once every check has passed.
  const store = () => gatewayDeps().openAppData(admitted.app.id).store;

  try {
    if (method === "GET") {
      if (item) {
        noteBrokerInvoked();
        const record = await store().get(ctx, route.recordId as string);
        if (!record)
          throw new HostedError("not_found", "That equipment request no longer exists.", {
            fix: "Go back to the list; it may have been removed, or the link may be from another app.",
          });
        return gatewayJson({ record }, { releaseId });
      }
      noteBrokerInvoked();
      const page = await store().list(ctx, listQuery(new URL(req.url)));
      return gatewayJson(page, { releaseId });
    }

    // Everything below changes data.
    assertSameOriginMutation(req, admitted.host, { requireJsonContentType: true });

    // The role gate runs before the body is read and before the store is
    // called, so a viewer's write costs nothing and touches nothing. The store
    // refuses the same thing independently; this is the gate that keeps
    // `brokerInvoked` at zero, which is what the sentinel test reads.
    if (APP_ROLE_RANK[admitted.grant.role] < APP_ROLE_RANK.editor)
      throw new HostedError(
        "forbidden",
        `Your role on this app is ${admitted.grant.role}; viewers can read equipment requests but cannot change them.`,
        { fix: "Ask an owner of this app to change your role to editor, then try again." }
      );

    const body = await gatewayDeps().readJsonBody(req, DEFAULT_LIMITS.bodyBytes);
    const writeId = writeIdOf(body);

    if (method === "POST") {
      noteBrokerInvoked();
      const { record, replayed } = await store().create(ctx, body as CreateRequestInput);
      await note(admitted, "record.created", "ok", writeId);
      return gatewayJson(
        { record },
        { status: 201, releaseId, headers: replayed ? { "x-zenith-replayed": "true" } : undefined }
      );
    }

    noteBrokerInvoked();
    const { record, replayed } = await store().update(ctx, route.recordId as string, body as UpdateRequestInput);
    await note(admitted, "record.updated", "ok", writeId);
    return gatewayJson(
      { record },
      { status: 200, releaseId, headers: replayed ? { "x-zenith-replayed": "true" } : undefined }
    );
  } catch (err) {
    if (err instanceof HostedError && err.code === "stale_version") await note(admitted, "record.conflict", "error");
    if (err instanceof HostedError && (err.code === "forbidden" || err.code === "csrf_rejected"))
      await noteAccessDenied(admitted.app, err.code, { subject: admitted.session.subject, releaseId });
    return respondWithError(err, { wantsHtml: false, releaseId });
  }
}

/** The list bounds a session is told about, so the app can page without guessing. */
export const BROKER_LIMITS = {
  listMax: TRACKER_LIMITS.listMax,
  bodyBytes: DEFAULT_LIMITS.bodyBytes,
} as const;
