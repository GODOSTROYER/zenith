/**
 * The bridge from the existing product actions to broker capabilities.
 *
 * Today `runAction` (`actions/core.ts`) authorizes by the actor's workspace
 * role and, for the Navigator, the install-wide autonomy dial. The broker
 * authorizes by capability, per-environment autonomy and policy. This module
 * is the mapping between the two, so the orchestrator can wire
 * `checkActionThroughBroker` into `runAction` for NAVIGATOR and INTEGRATION
 * actors without this workstream touching `actions/core.ts`.
 *
 * Three kinds of entry:
 *  - `capability`: the action changes something outside Zenith (or asks Zenith
 *    to); the broker decides it as that capability on the named scope.
 *  - `local`: the action edits Zenith's own desired state (the working
 *    manifest, settings). Nothing outside Zenith changes until a deploy, and the
 *    deploy is gated. The broker makes no decision; `runAction`'s role and
 *    autonomy rules still apply. (`system.*` manifest edits are here.)
 *  - not in the table: for an agent actor the bridge REFUSES (`action_not_mapped`),
 *    so a new action cannot silently bypass the broker.
 *
 * Only the fields listed in `pick` are forwarded as capability input — ids and
 * plain parameters. Nothing else from the action's input is ever copied: the
 * secret actions carry `secretValue`, and it must not reach a proposal, an
 * approver's screen, an event or a log.
 *
 * NOT WIRED: nothing calls this yet. `actions/core.ts` is not modified here.
 */
import type { ActionContext } from "@/lib/actions/core";
import type { Principal } from "@/lib/controlplane/types";
import type { CapabilityName } from "./catalog";
import { check, propose } from "./broker";
import { BrokerError, isBrokerError } from "./errors";
import type { BrokerDeps } from "./ports";
import type { DecisionView, ProposeResult } from "./types";

interface CapabilityMapping {
  kind: "capability";
  capability: CapabilityName;
  /** input fields forwarded verbatim as the capability input (references and plain parameters only) */
  pick: readonly string[];
  /** which action input field names the resource (service) id, when the capability is resource-scoped */
  resourceFrom?: string;
}

interface LocalMapping {
  kind: "local";
  why: string;
}

export type ActionMapping = CapabilityMapping | LocalMapping;

const cap = (capability: CapabilityName, pick: readonly string[] = [], resourceFrom?: string): CapabilityMapping => ({ kind: "capability", capability, pick, resourceFrom });
const local = (why: string): LocalMapping => ({ kind: "local", why });

const MANIFEST_EDIT = "Edits Zenith's working manifest only; nothing outside Zenith changes until a deploy, which is brokered.";

export const ACTION_CAPABILITY_MAP: Readonly<Record<string, ActionMapping>> = {
  /* deploy */
  "deploy.plan": cap("infrastructure.plan", ["message"]),
  "deploy.apply": cap("deployment.deploy", ["message"]),
  "deploy.rollback": cap("deployment.rollback", ["toRevisionId"]),
  "deploy.promote": cap("deployment.deploy", ["revisionId", "sourceEnvironmentId"]),
  "deploy.approve": local("Records a human's approval of a deployment inside the product; it grants nothing to an agent."),
  "deploy.cancel": local("Cancels a deployment the product itself started."),
  /* day-two operations */
  "ops.restartService": cap("service.restart", ["serviceId"], "serviceId"),
  "ops.scaleService": cap("service.scale", ["serviceId", "replicas", "size"], "serviceId"),
  "ops.investigate": cap("incident.investigate", []),
  /* environments and projects */
  "env.delete": cap("infrastructure.destroy", []),
  "env.create": local("Creates an environment record; provisioning happens at deploy."),
  "env.update": local("Edits environment settings inside Zenith."),
  "env.clone": local("Copies environment settings inside Zenith."),
  "env.updatePolicies": local("Edits environment approval policy inside Zenith; runAction's own role and autonomy rules apply. Per-environment autonomy is changed only through the broker's human-only endpoint."),
  "env.setBudget": local("Edits an environment budget inside Zenith."),
  "env.setConnection": local("Points an environment at a connection; the next deploy is brokered."),
  /* secrets: the VALUE is never forwarded */
  "system.setSecret": cap("secret.write", ["serviceId", "key"], "serviceId"),
  "system.rotateSecret": cap("secret.write", ["secretRef", "serviceId", "key"]),
  "system.removeSecret": cap("secret.write", ["serviceId", "key"], "serviceId"),
  /* manifest edits */
  "system.addService": local(MANIFEST_EDIT),
  "system.updateService": local(MANIFEST_EDIT),
  "system.removeService": local(MANIFEST_EDIT),
  "system.addResource": local(MANIFEST_EDIT),
  "system.updateResource": local(MANIFEST_EDIT),
  "system.removeResource": local(MANIFEST_EDIT),
  "system.addRoute": local(MANIFEST_EDIT),
  "system.updateRoute": local(MANIFEST_EDIT),
  "system.removeRoute": local(MANIFEST_EDIT),
  "system.bind": local(MANIFEST_EDIT),
  "system.unbind": local(MANIFEST_EDIT),
  "system.setEnvVar": local(MANIFEST_EDIT),
  "project.updateManifest": local(MANIFEST_EDIT),
  "project.applyBlueprint": local(MANIFEST_EDIT),
  "project.importCompose": local(MANIFEST_EDIT),
  "project.importResources": local(MANIFEST_EDIT),
  /* findings and alert rules are Zenith's own state */
  "security.resolveFinding": local("Changes the state of a finding inside Zenith."),
  "security.dismissFinding": local("Changes the state of a finding inside Zenith."),
  "security.reopenFinding": local("Changes the state of a finding inside Zenith."),
  "alerts.createRule": local("Edits an alert rule inside Zenith."),
  "alerts.updateRule": local("Edits an alert rule inside Zenith."),
  "alerts.deleteRule": local("Edits an alert rule inside Zenith."),
  "alerts.acknowledge": local("Acknowledges an alert inside Zenith."),
  "project.create": local("Creates a project record inside Zenith; nothing is provisioned until a deploy."),
  "workspace.rename": local("Renames the workspace inside Zenith."),
  // DELIBERATELY ABSENT — refused for agents until each has a capability of its own:
  //   alerts.createChannel / updateChannel / deleteChannel / testChannel
  //       a channel points Zenith at an external endpoint and a test sends data to it
  //   connection.create / check / disconnect      cloud credentials and connections
  //   workspace.setAutonomy                       the Navigator's own dial: only a person turns it
  //   project.delete                              destroys a project and its history
  //   app.create / publish / rollback / suspend / resume   hosted apps have their own reviewed flow
};

export const mappingFor = (actionId: string): ActionMapping | undefined =>
  Object.prototype.hasOwnProperty.call(ACTION_CAPABILITY_MAP, actionId) ? ACTION_CAPABILITY_MAP[actionId] : undefined;

/* --------------------------------- principal -------------------------------- */

/** The broker principal an action context represents. */
export function principalFromAction(ctx: ActionContext): Principal {
  if (ctx.integration) {
    return { kind: "integration", id: ctx.integration.clientId, name: `integration ${ctx.integration.clientId}`, integrationId: ctx.integration.clientId, onBehalfOf: ctx.actor.id };
  }
  if (ctx.actor.type === "navigator") return { kind: "navigator", id: ctx.actor.id, name: ctx.actor.name };
  if (ctx.actor.type === "system") return { kind: "system", id: ctx.actor.id, name: ctx.actor.name };
  return { kind: "user", id: ctx.actor.id, name: ctx.actor.name };
}

/* ---------------------------------- checking -------------------------------- */

export type BridgeResult =
  /** the broker does not decide this action; `runAction`'s own role/autonomy rules apply */
  | { kind: "not_brokered"; why: string }
  | { kind: "allow"; capability: CapabilityName; decision: DecisionView }
  | { kind: "require_approval"; capability: CapabilityName; decision: DecisionView; proposal?: ProposeResult }
  | { kind: "deny"; capability?: CapabilityName; decision?: DecisionView; code: string; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function buildRequest(ctx: ActionContext, mapping: CapabilityMapping, input: unknown) {
  const raw = isRecord(input) ? input : {};
  const str = (key: string): string | undefined => (typeof raw[key] === "string" && (raw[key] as string).length > 0 ? (raw[key] as string) : undefined);
  const picked: Record<string, unknown> = {};
  for (const key of mapping.pick) {
    const value = raw[key];
    if (value !== undefined) picked[key] = value;
  }
  return {
    capability: mapping.capability,
    scope: {
      workspaceId: ctx.workspaceId,
      ...((str("projectId") ?? ctx.projectId) ? { projectId: str("projectId") ?? ctx.projectId } : {}),
      ...((str("environmentId") ?? ctx.environmentId) ? { environmentId: str("environmentId") ?? ctx.environmentId } : {}),
      ...(mapping.resourceFrom && str(mapping.resourceFrom) ? { resourceId: str(mapping.resourceFrom) } : {}),
    },
    input: picked,
  };
}

/**
 * Ask the broker about a product action, for the orchestrator to call from
 * `runAction` when the actor is the Navigator or an integration.
 *
 *  - Human actors are `not_brokered` (their role is enforced by `runAction`).
 *  - A `local` action is `not_brokered`.
 *  - A mapped action is decided as its capability; `persist: true` also
 *    creates the operation (so a `require_approval` outcome lands in the
 *    approval queue) instead of only answering.
 *  - An unmapped action is denied for agents (`action_not_mapped`).
 *  - The broker being unreachable or a scope not resolving denies: an agent is
 *    never allowed because the broker could not answer.
 */
export async function checkActionThroughBroker(
  deps: BrokerDeps,
  ctx: ActionContext,
  actionId: string,
  input: unknown,
  options: { persist?: boolean; via?: "navigator" | "mcp" | "rest" } = {}
): Promise<BridgeResult> {
  const principal = principalFromAction(ctx);
  if (principal.kind === "user") return { kind: "not_brokered", why: "Human actors are authorized by their workspace role in runAction." };

  const mapping = mappingFor(actionId);
  if (!mapping) {
    return {
      kind: "deny",
      code: "action_not_mapped",
      message: `"${actionId}" has no capability mapping, so an agent may not run it. Add it to ACTION_CAPABILITY_MAP (as a capability or as local) before agents can.`,
    };
  }
  if (mapping.kind === "local") return { kind: "not_brokered", why: mapping.why };

  const request = buildRequest(ctx, mapping, input);
  try {
    if (options.persist) {
      const proposed = await propose(deps, request, principal, { via: options.via ?? (principal.kind === "navigator" ? "navigator" : "mcp") });
      const decision = proposed.decision;
      if (decision.outcome === "allow") return { kind: "allow", capability: mapping.capability, decision };
      if (decision.outcome === "require_approval") return { kind: "require_approval", capability: mapping.capability, decision, proposal: proposed };
      return { kind: "deny", capability: mapping.capability, decision, code: "policy_denied", message: decision.reasons.map((r) => r.message).join(" ") };
    }
    const { decision } = await check(deps, request, principal, { via: options.via });
    if (decision.outcome === "allow") return { kind: "allow", capability: mapping.capability, decision };
    if (decision.outcome === "require_approval") return { kind: "require_approval", capability: mapping.capability, decision };
    return { kind: "deny", capability: mapping.capability, decision, code: "policy_denied", message: decision.reasons.map((r) => r.message).join(" ") };
  } catch (error) {
    if (isBrokerError(error)) return { kind: "deny", capability: mapping.capability, code: error.code, message: error.message };
    throw new BrokerError("internal", "The capability broker could not evaluate this action.");
  }
}
