/**
 * Runner / machine protocol version negotiation with an explicit N-1 window
 * (PROD-OPS-03; protocol ids from MACH-04, docs/platform/RUNNER-PROTOCOL.md section 7).
 *
 * The control plane serves `window.current` and at most one `window.previous`
 * protocol. That is what lets the control plane be upgraded before its agents (and
 * rolled back after) without stranding a fleet: an N-1 agent keeps polling the N
 * control plane, and an N agent registers against the N control plane. An agent
 * outside the window gets `426 upgrade_required` naming the oldest protocol still
 * served; nothing falls back to an unsigned or weaker path.
 *
 * Registration negotiates: the agent lists the protocols it speaks (newest first)
 * and the control plane picks the newest one inside its window. An agent that does
 * not list any (every agent built before this change) is treated as speaking the
 * v1 baseline, which is only accepted while v1 is still inside the window.
 *
 * The chosen protocol is stored on the agent record and is the protocol id inside
 * every signature, so a later request is verified against exactly the protocol that
 * was negotiated (`request-auth.ts`), and a protocol that leaves the window later
 * refuses the already-registered agent the same way.
 */
import { AGENT_KINDS, AgentApiError, type AgentKind, type ProtocolWindow } from "@/lib/runners/types";

/** The protocol an agent that sends no list is assumed to speak. */
export const BASELINE_PROTOCOL: Readonly<Record<AgentKind, string>> = {
  runner: "zenith.runner/v1",
  machine: "zenith.machine/v1",
};

export const servedProtocols = (window: ProtocolWindow): readonly string[] => [window.current, ...window.previous];
/** The oldest protocol still served: what a refused agent must upgrade to at least. */
export const minimumProtocol = (window: ProtocolWindow): string => servedProtocols(window).at(-1)!;

export type Negotiation =
  | { ok: true; protocol: string; deprecated: boolean }
  | { ok: false; offered: readonly string[] };

/**
 * Pick the newest protocol the agent offers that the window serves. `deprecated` is
 * true when it is an N-1 protocol, so the control plane can tell the operator to
 * upgrade the agent.
 */
export function negotiateProtocol(window: ProtocolWindow, offered: readonly string[]): Negotiation {
  for (const candidate of servedProtocols(window)) {
    if (offered.includes(candidate)) return { ok: true, protocol: candidate, deprecated: candidate !== window.current };
  }
  return { ok: false, offered };
}

/** The 426 an agent gets when nothing it speaks is inside the window. Carries the window so the agent can report it. */
export function upgradeRequiredError(kind: AgentKind, window: ProtocolWindow = AGENT_KINDS[kind].window): AgentApiError {
  const minimum = minimumProtocol(window);
  return new AgentApiError(
    426,
    "upgrade_required",
    `This control plane no longer accepts the agent's protocol version; upgrade the agent to ${minimum} or later.`,
    { minimumProtocol: minimum, currentProtocol: window.current, supportedProtocols: [...servedProtocols(window)] }
  );
}

/** Registration-time selection. Throws the 426 when the agent is outside the window. */
export function selectRegistrationProtocol(kind: AgentKind, offered: readonly string[] | undefined, window: ProtocolWindow = AGENT_KINDS[kind].window): { protocol: string; deprecated: boolean } {
  const list = offered && offered.length > 0 ? offered : [BASELINE_PROTOCOL[kind]];
  const result = negotiateProtocol(window, list);
  if (!result.ok) throw upgradeRequiredError(kind, window);
  return { protocol: result.protocol, deprecated: result.deprecated };
}
