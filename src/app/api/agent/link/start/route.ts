/**
 * `POST /api/agent/link/start` — a terminal asks to be linked.
 *
 * Unauthenticated by design: the caller has no credential yet, which is the
 * whole point. What it gets back is a device code (the real secret, 256 bits,
 * hashed at rest and never in a URL or a log line) and a user code (8 symbols,
 * not a credential, safe to show and to carry in the verification link).
 *
 * This route is on the middleware bypass list because it carries no cookie and
 * authenticates nothing. The `/agent/link` page deliberately is not, so the
 * session gate still sends a signed-out user to `/login?next=…`.
 */
import { controlOrigin, failure, json } from "@/lib/agent-access/control/boundary";
import { linkRateLimit, requireLinkAuthority } from "@/lib/agent-access/authority";
import {
  LINK_POLL_INTERVAL_S,
  LINK_PROTOCOL_VERSION,
  LINK_TTL_MS,
  clientAddress,
  hashDeviceCode,
  hashUserCode,
  limitKey,
  linkJson,
  mintDeviceCode,
  mintUserCode,
  parseStartRequest,
} from "@/lib/agent-access/link/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A link request is three small statements; nothing here is worth a minute. */
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  try {
    const authority = await requireLinkAuthority();
    const key = limitKey(clientAddress(request));
    // Two windows on one key: a burst ceiling and an hourly one, so a caller
    // cannot mint codes all day long at five a minute.
    await linkRateLimit("link.start", key, { limit: 5, windowMs: 60_000 });
    await linkRateLimit("link.start.hour", key, { limit: 40, windowMs: 3_600_000 });

    const input = parseStartRequest(await linkJson(request, 4096));
    const origin = controlOrigin();
    const userCode = mintUserCode();
    const deviceCode = mintDeviceCode();
    const now = Date.now();

    await authority.startLink({
      userCodeHash: hashUserCode(userCode.replace(/-/g, "")),
      deviceCodeHash: hashDeviceCode(deviceCode),
      clientName: input.clientName,
      ...(input.clientVersion === undefined ? {} : { clientVersion: input.clientVersion }),
      ...(input.label === undefined ? {} : { label: input.label }),
      requestedScopes: input.requestedScopes,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + LINK_TTL_MS).toISOString(),
    });

    return json(
      {
        deviceCode,
        userCode,
        verificationUri: `${origin}/agent/link`,
        // The *user* code in a URL is a deliberate, bounded exposure: it is not
        // a credential, it expires in ten minutes and it is useless without a
        // signed-in approval. The device code and the issued token never appear
        // in any URL.
        verificationUriComplete: `${origin}/agent/link?code=${encodeURIComponent(userCode)}`,
        interval: LINK_POLL_INTERVAL_S,
        expiresIn: LINK_TTL_MS / 1000,
        protocolVersion: LINK_PROTOCOL_VERSION,
      },
      201
    );
  } catch (error) {
    const response = failure(error);
    if (response.status === 429) response.headers.set("retry-after", "60");
    return response;
  }
}
