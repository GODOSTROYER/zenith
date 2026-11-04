/**
 * GET  /api/platform/v1/connections          list (viewer; person or linked credential)
 * POST /api/platform/v1/connections          create (admin; browser only)
 *
 * POST body: `{ provider: "gcp" | "azure" | "oci" | "zenith", ...identifiers }` (zenith takes only an optional label), or
 * `{ provider, mode: "runner", runnerId, ...identifiers }` for customer runners.
 * Native AWS and
 * Kubernetes creation keep their dedicated web flows (`/platform/connections/aws`,
 * Settings, Connections) because they hand back trust values the person must
 * act on; every provider is verified, revoked and rotated here.
 */
import { z } from "zod";
import { BrokerError } from "@/lib/capabilities/errors";
import { listConnections } from "@/lib/connections/service";
import { parseWith, platformRoute, readJson } from "../_lib/http";
import { browserCaller, idempotencyKey, personOrCredentialCaller, runLifecycle } from "../_lib/connections";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ACTION = { gcp: "connection.createGcp", azure: "connection.createAzure", oci: "connection.createOci", zenith: "connection.createZenith" } as const;
const Body = z.object({ provider: z.enum(["aws", "gcp", "azure", "oci", "kubernetes", "zenith"]), mode: z.enum(["runner"]).optional() }).passthrough();

export const GET = platformRoute(async (req) => {
  const caller = await personOrCredentialCaller(req);
  const include = req.nextUrl.searchParams.get("includeRevoked");
  if (include !== null && include !== "true" && include !== "false") throw new BrokerError("invalid_request", "includeRevoked must be true or false.");
  return { body: { connections: await listConnections(caller.ctx, { includeRevoked: include !== "false" }) } };
});

export const POST = platformRoute(async (req) => {
  const caller = await browserCaller(req);
  const body = parseWith(Body, await readJson(req));
  if (body.mode === "runner") return runLifecycle(caller, "connection.createRunner", body, idempotencyKey(req));
  const { provider, ...input } = body;
  if (!(provider in ACTION)) throw new BrokerError("invalid_request", "Use the guided browser flow for this provider, or explicitly select runner mode.");
  return runLifecycle(caller, ACTION[provider as keyof typeof ACTION], input, idempotencyKey(req));
});
