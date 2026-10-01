/**
 * Who is calling /api/platform/v1, and in which workspace.
 *
 * Three kinds of caller reach the broker over HTTP:
 *
 *  1. A SIGNED-IN PERSON (session cookie) → `user` principal. With Supabase
 *     configured a session is REQUIRED: `resolveActor` alone would answer the
 *     demo actor `local` (an admin) for an unauthenticated request, and the
 *     platform routes take their workspace from the request rather than from
 *     `requireWorkspace()`, so the session check is made here, explicitly.
 *     Without Supabase (local demo) the single local user is `local`.
 *  2. An INTEGRATION (`Authorization: Bearer za_…`) → `integration` principal,
 *     bound to the credential's subject and workspace. The credential is
 *     verified against the authority on every request, so revocation is
 *     immediate.
 *  3. The NAVIGATOR's own in-process call (actor key header) → `navigator`.
 *
 * The workspace is the credential's for an integration; for a person it is
 * `x-zenith-workspace` / `?workspace=` when given, else the active workspace.
 * Membership in it is verified by the broker's role resolver on every call — a
 * workspace you are not in is the same 404 as one that does not exist.
 */
import type { NextRequest } from "next/server";
import type { Principal } from "@/lib/controlplane/types";
import { requireCredentialAuthority } from "@/lib/agent-access/authority";
import { BrokerError, notFound } from "@/lib/capabilities/errors";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { currentRequest } from "@/lib/server/request";
import { resolveActor } from "@/lib/server/actor";
import { requireWorkspace } from "@/lib/server/workspace";

export interface CallerContext {
  principal: Principal;
  workspaceId: string;
  via: "session" | "bearer" | "navigator" | "demo";
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** The workspace the caller explicitly named, if any (header wins over query; conflict is refused). */
function namedWorkspace(req: NextRequest): string | undefined {
  const header = req.headers.get("x-zenith-workspace") ?? undefined;
  const query = req.nextUrl.searchParams.get("workspace") ?? undefined;
  if (header && query && header !== query) throw new BrokerError("invalid_request", "The workspace header and query parameter disagree.");
  const named = header ?? query;
  if (named !== undefined && !ID.test(named)) throw notFound();
  return named;
}

export async function callerOf(req: NextRequest): Promise<CallerContext> {
  const named = namedWorkspace(req);

  const authorization = req.headers.get("authorization");
  if (authorization) {
    const authority = await requireCredentialAuthority();
    const credential = await authority.verify(authorization);
    if (named !== undefined && named !== credential.workspaceId) throw notFound();
    return {
      principal: {
        kind: "integration",
        id: credential.id,
        name: credential.label ?? `integration ${credential.id}`,
        integrationId: credential.id,
        onBehalfOf: credential.subject,
      },
      workspaceId: credential.workspaceId,
      via: "bearer",
    };
  }

  const actor = await resolveActor(req);
  const state = currentRequest();
  if (actor.type === "navigator") {
    return {
      principal: { kind: "navigator", id: actor.id, name: actor.name, ...(state?.user ? { onBehalfOf: state.user.id } : {}) },
      workspaceId: named ?? requireWorkspace().id,
      via: "navigator",
    };
  }
  if (state?.user) {
    return { principal: { kind: "user", id: state.user.id, name: state.user.name || state.user.email }, workspaceId: named ?? requireWorkspace().id, via: "session" };
  }
  if (isSupabaseConfigured()) {
    throw new BrokerError("unauthenticated", "Sign in to use the platform API, or present an integration credential.", "Sign in, or send Authorization: Bearer <credential>.");
  }
  // Local demo mode: the one local user.
  return { principal: { kind: "user", id: actor.id, name: actor.name }, workspaceId: named ?? requireWorkspace().id, via: "demo" };
}
