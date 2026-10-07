/** Exact additive successor identities used ONLY for historical test projections. */
export const incomingPlatformIds = new Set(
["platform-postgres:tests/controlplane/durable-intent-authority.test.ts:932f3808dde1", "platform-postgres:tests/controlplane/executable-semantics.test.ts:e9879ff0d6eb", "platform-postgres:tests/controlplane/k8s-guest-bindings.test.ts:69e0124d07dc", "platform-postgres:tests/controlplane/mixed-parent-plans.test.ts:a2c1d654d201", "platform-postgres:tests/controlplane/mixed-runs.test.ts:e483ae1e82c7", "platform-postgres:tests/controlplane/plan-custody.test.ts:35394b79986e", "platform-postgres:tests/controlplane/state-backend-recovery.test.ts:7d391123fdde", "platform-postgres:tests/capabilities/standing-grants.test.ts:8e0139c01528", "platform-postgres:tests/effects/build-launch.test.ts:66558e46614c", "platform-postgres:tests/effects/cleanup.test.ts:56d57a2f04e0", "platform-postgres:tests/effects/ledger.test.ts:5b8ae9d0841b", "platform-postgres:tests/effects/provider-resolvers.test.ts:ae6277c04b4b", "platform-postgres:tests/effects/proxy.test.ts:71ecab8d34b4", "platform-postgres:tests/effects/resolvers.test.ts:514f933542c5", "platform-postgres:tests/repair/lifecycle.platform.test.ts:8c02d63e3cde", "platform-postgres:tests/coding-agent/store.test.ts:a2b7923f32dd", "platform-postgres:tests/controlplane/mcp-stream-tenant-index.test.ts:2754979ea1cc"]
);
export const incomingWorkflowFiles = new Set(
["tests/platform/plan-custody-crypto.test.ts", "tests/platform/semantics-approval.test.ts", "tests/platform/state-session.test.ts", "tests/workflows/coding-agent.test.ts", "tests/workflows/mixed-parent.test.ts", "tests/workflows/start-recovery.test.ts", "tests/workflows/upgrade-rehearsal.test.ts", "tests/workflows/versioning-audit.test.ts"]
);
export function withoutIncomingPlatform<T extends { id: string }>(items: T[]): T[] {
  return items.filter(item => !incomingPlatformIds.has(item.id));
}

export const incomingWorkflowIds = new Set([...incomingWorkflowFiles].map(file => `workflows:${file}:4ee93ed6c454`));
