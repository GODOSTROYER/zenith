/** Shared production authorization for browser and MCP continuation. No source tokens escape this boundary. */
import { BrokerError } from "@/lib/capabilities/errors";
import { createRunHandoff, type HandoffRequest } from "./handoff";
import { assertRunSourceAccess, codingAgentStore } from "./platform";
import { AgentServiceError } from "./service";

export async function authorizedRunHandoff(request: HandoffRequest) {
  return createRunHandoff({
    store: await codingAgentStore(),
    async authorizeSource(_workspaceId, _source, row) {
      try {
        await assertRunSourceAccess(row);
      } catch (error) {
        if (error instanceof AgentServiceError && error.code === "invalid_state") throw new BrokerError("invalid_state", error.message);
        throw new BrokerError("policy_denied", "Current repository access could not be confirmed. Reconnect or refresh the source before exporting context.");
      }
    },
  }, request);
}
