/**
 * The scope rules both credential authorities hold an approval to, whatever
 * the parser already said. Kept apart from `pg.ts` so the file authority does
 * not load the Postgres client to check a list length.
 */
import { AgentError } from "../security";
import type { ApproveLinkInput } from "./types";

/**
 * A whole-workspace grant names no projects and no environments; every other
 * grant names 1-100 projects. Returns the flag as a boolean. The same two
 * rules are CHECK constraints in `0008_agent_workspace_scope.sql`.
 */
export function checkScopeShape(input: ApproveLinkInput): boolean {
  const allProjects = input.allProjects === true;
  const ok = allProjects
    ? input.projectIds.length === 0 && input.environmentIds === undefined
    : input.projectIds.length >= 1 && input.projectIds.length <= 100;
  if (!ok)
    throw new AgentError(
      "invalid_request",
      allProjects
        ? "A whole-workspace grant names no projects and no environments."
        : "Choose between 1 and 100 projects, or the whole workspace.",
      400
    );
  return allProjects;
}

/**
 * A whole-workspace grant asked for on a link a protocol-1 client started. That
 * client rejects an empty `projectIds` at exchange, which would burn the
 * single-use token, so the approval is refused before anything is written.
 */
export const protocolTooOld = (): AgentError =>
  new AgentError(
    "protocol_upgrade_required",
    "This terminal speaks link protocol 1, which cannot receive a whole-workspace grant. Choose specific projects, or update the Zenith plugin and run `zenith login` again.",
    409
  );
