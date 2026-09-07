/**
 * The app-host gateway: admission before any app code or data is touched.
 *
 *   handle.ts      the pipeline, in contract order
 *   admission.ts   steps 1–8, runtime-agnostic, shared with the policy endpoint
 *   reserved.ts    /_zenith/* — sign-in, callback, sign-out, session, health
 *   broker.ts      /_zenith/data/v1/* — the fixed broker's HTTP surface
 *   artifacts.ts   step 9 — files, HEAD, Range, ETag
 *   guard.ts       the one exit every response passes through
 *   errors.ts      refusals: JSON for programs, a page for people
 *   telemetry.ts   the invocation sentinel a denial test reads
 *   deps.ts        the seam a test injects sibling-workstream doubles through
 *
 * Import from here, not from a file inside.
 *
 * Workstream W6 (hosted R3).
 */
export { handleGateway, type GatewayParams } from "./handle";
export {
  decideAdmission,
  type AdmissionDecision,
  type AdmissionInput,
  type AdmittedRequest,
  type ReservedRoute,
  type ReservedRouteId,
} from "./admission";
export { assertSameOriginMutation, BROKER_LIMITS } from "./broker";
export { brokerScriptName, releaseScriptName } from "@/lib/hosted/runtime/names";
export { artifactTargetFor, matchesEtag, parseByteRange } from "./artifacts";
export {
  applyResponseGuard,
  CACHE_CONTROL,
  GATEWAY_CSP,
  GATEWAY_SECURITY_HEADERS,
  isHashedAssetPath,
  type CacheMode,
} from "./guard";
export { methodNotAllowed, respondWithError, secondsToNextUtcMidnight } from "./errors";
export { signInPage, type GatewayHealth } from "./reserved";
export {
  gatewayTelemetry,
  resetGatewayTelemetry,
  type GatewayTelemetry,
} from "./telemetry";
export {
  gatewayDeps,
  resetGatewayDeps,
  setGatewayDepsForTests,
  type GatewayDeps,
} from "./deps";
