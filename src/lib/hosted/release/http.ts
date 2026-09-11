/**
 * What the hosted control routes share — now one module up, at
 * `@/lib/server/hosted`.
 *
 * The error mapping is the thing this layer really adds: `route()` answers
 * anything that is not an `ApiError` with a 500, which is the right default and
 * the wrong answer for a hosted refusal — a duplicate slug is a 409, a
 * suspended app is a 423, an unavailable runtime is a 503, and each of those
 * codes is what tells a caller whether to change the request, wait, or stop.
 * `hostedRoute` restores them, once, for every hosted route.
 *
 * Moving it to L5 is what removes this file's two cycles (`→ server/context`
 * and `→ actions/core`): calling L4 from the request edge is the normal
 * direction. This file stays as the import path it always was.
 */
export {
  accepted,
  actorOf,
  executeHosted,
  hostedErrorFromResult,
  hostedJson,
  hostedRoute,
  isAppOwner,
  limitsBlock,
  ownerOnlyBlock,
  readJsonBody,
  requireAppOwner,
  requireWorkspaceRole,
  runtimeStatus,
  subjectOf,
  type AppOwner,
  type HostedGrant,
  type HostedRouteOptions,
  type OwnerCheck,
  type ReadBodyOptions,
} from "@/lib/server/hosted";
