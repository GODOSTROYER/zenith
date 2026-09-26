/**
 * `POST /api/agent/link/token` — the terminal's poll.
 *
 * Authenticated by possession of the device code and nothing else, so the code
 * is compared as a digest and never written anywhere in the clear.
 *
 * `authorization_pending` and `slow_down` are **HTTP 200 with a status in the
 * body**, so a polling client never has to tell "not yet" apart from a
 * transport failure. Denial, expiry and an unknown code carry their real
 * status, because those are the three answers that mean *stop polling*.
 *
 * This is the only response in the system that contains the issued bearer. The
 * exchange is single-use: the same statement that hands the token over consumes
 * the row and destroys the stored copy, so a concurrent second poller is told
 * the code expired rather than handed a duplicate.
 */
import { controlOrigin, failure, json } from "@/lib/agent-access/control/boundary";
import { linkRateLimit, requireLinkAuthority } from "@/lib/agent-access/authority";
import { requireAgentWaitlistAccess } from "@/lib/agent-access/waitlist";
import {
  clientAddress,
  hashDeviceCode,
  limitKey,
  linkJson,
  parseTokenRequest,
} from "@/lib/agent-access/link/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  try {
    const authority = await requireLinkAuthority();
    await linkRateLimit("link.poll", limitKey(clientAddress(request)), {
      limit: 30,
      windowMs: 60_000,
    });

    const deviceCode = parseTokenRequest(await linkJson(request, 1024));
    const result = await authority.exchange(
      hashDeviceCode(deviceCode),
      undefined,
      requireAgentWaitlistAccess
    );

    switch (result.status) {
      case "authorization_pending":
      case "slow_down":
        return json({ status: result.status, interval: result.interval });
      case "issued":
        return json({
          status: "issued",
          token: result.token,
          credentialId: result.credential.id,
          origin: controlOrigin(),
          workspaceId: result.credential.workspaceId,
          projectIds: result.credential.projectIds,
          environmentIds: result.credential.environmentIds ?? null,
          scopes: result.credential.scopes,
          expiresAt: result.credential.expiresAt,
          label: result.credential.label ?? null,
        });
      case "denied":
        return json(
          {
            error: {
              code: "access_denied",
              message:
                "The request was denied in the browser. Run `zenith login` again if that was a mistake.",
              requestId: crypto.randomUUID(),
            },
          },
          403
        );
      case "expired":
        return json(
          {
            error: {
              code: "expired_token",
              message: "This link request expired or was already used. Run `zenith login` again.",
              requestId: crypto.randomUUID(),
            },
          },
          410
        );
      default:
        // An unknown code and a wrong one get the same answer.
        return json(
          {
            error: {
              code: "invalid_device_code",
              message: "This device code is not one this server issued. Run `zenith login` again.",
              requestId: crypto.randomUUID(),
            },
          },
          404
        );
    }
  } catch (error) {
    const response = failure(error);
    if (response.status === 429) response.headers.set("retry-after", "60");
    return response;
  }
}
