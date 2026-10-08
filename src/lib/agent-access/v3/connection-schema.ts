import { z } from "zod/v4";
import { RUNNER_ACTIONS } from "@/lib/connections/handoff";
import { Id } from "./schemas";

export const PlanRunnerConnectionInput = z.object({
  target: z.object({ workspaceId: Id, projectId: Id }).strict(),
  action: z.enum(RUNNER_ACTIONS),
  input: z.record(z.string(), z.unknown()).describe("Identifier-only input of the registered connection action. Creation requires provider, mode runner, runnerId and provider identifiers. Rotation uses connectionId and patch; promote/abort use connectionId and rotationId; verify/revoke use connectionId."),
}).strict();
