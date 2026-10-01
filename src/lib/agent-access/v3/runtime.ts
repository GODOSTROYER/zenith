/** Lazy production wiring. Tests supply ports explicitly; importing the route
 * alone never opens a database, file authority or Temporal connection. */
import type { AuthDeps } from "./auth";
import type { McpPorts } from "./ports";
import type { AgentIdentity } from "./principal";

export interface McpRuntime {
  ports: McpPorts;
  auth: AuthDeps;
  throttle(identity: AgentIdentity): Promise<void>;
  requireEnabled(): Promise<void>;
}

type Global = typeof globalThis & { __zenithMcpRuntimeV3?: { override?: McpRuntime; pending?: Promise<McpRuntime> } };
const state = () => ((globalThis as Global).__zenithMcpRuntimeV3 ??= {});

export function setMcpRuntimeForTests(runtime: McpRuntime | null): void {
  state().override = runtime ?? undefined;
}

export async function mcpRuntime(): Promise<McpRuntime> {
  const s = state();
  if (s.override) return s.override;
  s.pending ??= (async () => {
    const { defaultPorts } = await import("./adapters");
    const { defaultAuth } = await import("./auth-default");
    const { throttleAsync } = await import("../control/rate-limit");
    const { requireControlAsync } = await import("../control/runtime");
    return { ports: defaultPorts(), auth: defaultAuth(),
      throttle: (identity: AgentIdentity) => throttleAsync({ ...identity,
        projectIds: [...identity.projectIds], scopes: [...identity.scopes],
        environmentIds: identity.environmentIds ? [...identity.environmentIds] : undefined,
        appIds: identity.appIds ? [...identity.appIds] : undefined }, { scope: "v3" }),
      requireEnabled: requireControlAsync };
  })().catch((error: unknown) => { s.pending = undefined; throw error; });
  return s.pending;
}
