/**
 * Why a control on an app's page is refused, worked out once so every button
 * that depends on the same rule says the same sentence.
 *
 * Publishing needs two roles at once — editor in the workspace and owner on the
 * app — and the order below is the order a person can act on: the app's own
 * state first, then the two roles, then the machinery, then whatever is already
 * running. The server enforces all of it; this is what lets a button refuse
 * before it is pressed.
 *
 * Pure — no React.
 */
import type { AppState, Availability } from "@/lib/hosted/contracts";
import type { BuilderInfo } from "@/lib/client/hosted";

export type WorkspaceRole = "admin" | "editor" | "viewer" | null;

export interface GateInput {
  appName: string;
  appState: AppState;
  workspaceRole: WorkspaceRole;
  workspaceName: string;
  /** the caller holds an owner grant on this app */
  isOwner: boolean;
  runtime?: { availability: Availability };
  /** every runner this install knows about, as the API lists them */
  builders?: BuilderInfo[];
  buildsPaused?: boolean;
  buildsPausedReason?: string;
  hasRunningJob: boolean;
}

const canEdit = (role: WorkspaceRole): boolean => role === "admin" || role === "editor";

/** App state and the two roles — everything that is about the person, not the machine. */
function accessReason(input: GateInput): string | undefined {
  if (input.appState === "suspended")
    return `${input.appName} is suspended. Resume it before publishing or rolling back.`;
  if (input.appState === "recovering")
    return `${input.appName} is in recovery. Publishing is closed until an operator finishes the check.`;
  if (input.appState === "deleted") return `${input.appName} has been deleted.`;
  if (!canEdit(input.workspaceRole))
    return `Publishing needs the editor role in ${input.workspaceName} and you are ${input.workspaceRole ?? "not signed in"}. Ask a workspace admin to raise your role in Settings → Members.`;
  if (!input.isOwner)
    return `Publishing needs the owner role on ${input.appName}. Ask an owner to publish, or to make you an owner in Audience.`;
  return undefined;
}

const runtimeReason = (input: GateInput): string | undefined =>
  input.runtime && !input.runtime.availability.available
    ? (input.runtime.availability.reason ?? "The service that serves these apps is unavailable.")
    : undefined;

/**
 * The API lists the runners it knows about, not the one it would choose, so the
 * only refusal this screen can make honestly is that *none* of them can run.
 * Which of the available ones is selected stays the server's decision.
 */
const builderReason = (input: GateInput): string | undefined => {
  const builders = input.builders;
  if (!builders || builders.length === 0) return undefined;
  if (builders.some((b) => b.availability.available)) return undefined;
  const first = builders.find((b) => b.availability.reason)?.availability.reason;
  return `No build runner on this install can run right now, so a publish would be refused before it started.${first ? ` ${first}` : ""}`;
};

const pausedReason = (input: GateInput): string | undefined =>
  input.buildsPaused
    ? (input.buildsPausedReason ??
      `Builds are paused because ${input.workspaceName} reached its spending envelope.`)
    : undefined;

const jobReason = (input: GateInput): string | undefined =>
  input.hasRunningJob
    ? "A publish is already running for this app. Wait for it to finish before starting another."
    : undefined;

/** Why Publish cannot be pressed, or `undefined` when it can. */
export function publishBlockedReason(input: GateInput): string | undefined {
  return (
    accessReason(input) ??
    runtimeReason(input) ??
    builderReason(input) ??
    pausedReason(input) ??
    jobReason(input)
  );
}

/** Rolling back needs no builder: the release it goes back to was already built. */
export function rollbackBlockedReason(input: GateInput): string | undefined {
  return accessReason(input) ?? runtimeReason(input) ?? jobReason(input);
}

/** Suspending or reopening an app needs the owner role and workspace admin. */
export function stateChangeBlockedReason(input: GateInput): string | undefined {
  if (!input.isOwner)
    return `Changing whether ${input.appName} is open needs the owner role on it.`;
  if (input.workspaceRole !== "admin")
    return `This needs the admin role in ${input.workspaceName} and you are ${input.workspaceRole ?? "not signed in"}. Ask a workspace admin to run it.`;
  if (input.appState === "recovering")
    return `${input.appName} is in recovery. Only an operator can reopen it.`;
  if (input.hasRunningJob)
    return "Something is already running for this app. Wait for it to finish.";
  return undefined;
}
