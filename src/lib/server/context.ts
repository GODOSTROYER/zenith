/**
 * Request context + JSON conventions for every /api route — the barrel.
 *
 * The six concerns this file used to hold now live one per module, and this is
 * the import path they all keep answering to:
 *
 * | Module | Owns |
 * | --- | --- |
 * | `server/errors.ts` | `ApiError`, `notFound`, `json`, `errorResponse` |
 * | `server/request.ts` | `route()`, the request scope, `currentRequest`, `intParam` |
 * | `server/workspace.ts` | which workspace a request acts in, and who belongs to it |
 * | `server/membership.ts` | joining a workspace: invites, roles, refusals |
 * | `server/actor.ts` | who is calling and their role here |
 * | `server/scope.ts` | workspace-bound id resolvers and `buildCtx` |
 *
 * Nothing is declared here. New code may import the module it means; existing
 * importers were left alone deliberately, because a barrel that keeps working
 * is what made the split a safe change rather than a 51-file one.
 */
export { ApiError, errorResponse, json, notFound } from "@/lib/server/errors";

export {
  currentRequest,
  intParam,
  route,
  type RequestState,
  type RouteGrant,
  type RouteOptions,
} from "@/lib/server/request";

export {
  WORKSPACE_COOKIE,
  currentWorkspace,
  destinationAfterAuth,
  membershipCheck,
  requireWorkspace,
  workspacesFor,
} from "@/lib/server/workspace";

export {
  ensureMember,
  isLastAdmin,
  readInvites,
  soleAdminWorkspaces,
  writeInvites,
  type MemberDenial,
} from "@/lib/server/membership";

export {
  demoActor,
  navigatorActor,
  navigatorHeaders,
  requireAdmin,
  resolveActor,
  workspaceRole,
} from "@/lib/server/actor";

export {
  buildCtx,
  readAutonomy,
  scopedDeployment,
  scopedEnvironment,
  scopedProject,
  type Scope,
} from "@/lib/server/scope";
