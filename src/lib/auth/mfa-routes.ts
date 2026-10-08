/** The privileged HTTP inventory. Runs in route() BEFORE the handler and its side effects. */
import type { NextRequest } from "next/server";
import { currentRequest } from "@/lib/server/request";
import { requireStepUp } from "./mfa";
import { workspaceMfaControl } from "./mfa-policy";
import type { ActionDef } from "@/lib/actions/core";
import { ApiError } from "@/lib/server/errors";
import { resolveActor } from "@/lib/server/actor";

type Boundary = "human" | "human-or-machine";
const READ = new Set(["GET", "HEAD", "OPTIONS"]);
const PLATFORM = "/api/platform/v1";

/** Machine-capable verbs retain their existing credential, scope and policy checks. */
export function privilegedRoute(path: string, method: string): Boundary | undefined {
  // The GitHub OAuth callback binds trust on GET as well as POST.
  if (path === `${PLATFORM}/github/callback` || path === "/api/auth/mfa/verify") return "human";
  if (READ.has(method.toUpperCase())) return undefined;
  if (path === "/platform/connections/aws/action") return "human";
  if (/^\/api\/(workspace\/(members|invites|ownership|mfa|retention-destination)|integrations\/|secrets(?:\/|$)|settings(?:\/|$)|account$)/.test(path)) return "human";
  if (/^\/api\/hosted\/(apps(?:\/|$)|ops\/)/.test(path)) return "human";
  if (!path.startsWith(`${PLATFORM}/`)) return undefined;
  const relative = path.slice(PLATFORM.length);
  if (/^\/(runners|machines)\/[^/]+\/update$/.test(relative)) return "human";
  if (/^\/(audit\/exports|environments\/[^/]+\/domains(?:\/(verify|revoke))?|recovery\/items\/[^/]+\/decide)$/.test(relative)) return "human";
  if (/^\/(workspace\/policy|environments\/[^/]+\/(autonomy|optimizer|spend|state-backend\/restores\/(approve|reject|execute))|standing-grants(?:\/[^/]+\/revoke)?|mixed-output-preauthorizations(?:\/[^/]+\/revoke)?|releases\/[^/]+\/approve-migration|effects\/[^/]+\/resolve|operations\/[^/]+\/(approve|reject|start-portability|mixed-run\/teardown)|runbooks(?:\/(runs|schedules)\/[^/]+\/approve)?|github\/(binding(?:\/unbind)?|callback)|mixed\/plans(?:\/[^/]+\/(children|start))?|runners\/tokens|(?:runners|machines)\/[^/]+\/revoke)$/.test(relative)) return "human";
  if (/^\/connections(?:\/[^/]+(?:\/(rotate|rotation\/(promote|abort)))?)?$/.test(relative)) return "human";
  if (/^\/(connections\/[^/]+\/(verify|revoke)|runners\/tokens|(?:runners|machines)\/[^/]+\/revoke|operations\/[^/]+\/(cancel|start-portability|mixed-run\/(cancel|teardown))|environments\/[^/]+\/(state-backend(?:\/.*)?|teardown-review|spend)|runbooks(?:\/.*)?|coding-agent\/runs(?:\/.*)?|mixed\/plans\/[^/]+\/start)$/.test(relative)) return "human-or-machine";
  return undefined;
}

export function privilegedAction(def: Pick<ActionDef, "id" | "requiredRole" | "risk" | "mutates" | "category">): boolean {
  return def.mutates && (def.requiredRole === "admin" || def.risk === "high" || ["connection", "secrets", "operations", "deploy"].includes(def.category));
}

export async function guardPrivilegedRoute(req: NextRequest, adminMutation = false, verifiedIntegration = false): Promise<void> {
  const state = currentRequest();
  let boundary = privilegedRoute(req.nextUrl.pathname, req.method);
  if (READ.has(req.method.toUpperCase()) && !boundary) return;
  const header = req.headers.get("x-zenith-workspace");
  const query = req.nextUrl.searchParams.get("workspace");
  // The caller/role resolver still owns membership and foreign-workspace denials.
  if (header && query && header !== query) throw new ApiError("The workspace header and query disagree.", 400);
  const namedScope = req.nextUrl.pathname.startsWith(`${PLATFORM}/`);
  const workspaceId = namedScope ? header ?? query ?? state?.workspace?.id : state?.workspace?.id;
  if (workspaceId && !/^[A-Za-z0-9_-]{1,100}$/.test(workspaceId)) throw new ApiError("Workspace not found.", 404);
  if (adminMutation) boundary = "human";
  const action = /^\/api\/actions\/([^/]+)$/.exec(req.nextUrl.pathname);
  if (action) {
    const body: unknown = await req.clone().json().catch(() => null);
    if (body && typeof body === "object" && "mode" in body && body.mode === "execute") {
      const def = (await import("@/lib/actions/core")).actionRegistry().get(decodeURIComponent(action[1]));
      if (def && privilegedAction(def)) boundary = "human-or-machine";
      // Human approval and trust changes never acquire a machine exception.
      if (def && (def.id === "deploy.approve" || def.category === "connection" || def.category === "secrets" || def.requiredRole === "admin")) boundary = "human";
    }
  }
  const machine = req.headers.has("authorization") || req.headers.has("x-zenith-actor") || req.headers.has("x-zenith-actor-key");
  if (boundary !== "human" && machine) {
    // Header presence is not authentication. Only the wrapper's verified transport
    // or the existing keyed in-process Navigator may retain machine authority.
    if (verifiedIntegration) return;
    if (req.headers.has("x-zenith-actor") && (await resolveActor(req)).type === "navigator") return;
    if (req.headers.has("authorization")) {
      const { requireCredentialAuthority } = await import("@/lib/agent-access/authority");
      let credential;
      try { credential = await (await requireCredentialAuthority()).verify(req.headers.get("authorization")); }
      catch { throw new ApiError("Supply a verified integration credential.", 403); }
      if (credential.workspaceId === workspaceId) return;
      throw new ApiError("Workspace not found.", 404);
    }
  }
  if (!boundary && !(await workspaceMfaControl(workspaceId)).requireForAllMutations) return;
  await requireStepUp(req, { subject: state?.user?.id ?? "", workspaceId });
}
