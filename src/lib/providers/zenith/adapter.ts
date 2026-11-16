/**
 * The Zenith-managed platform as a registered provider (PROD-MAN-01 front door).
 *
 * Registering it is what lets the product offer a managed connection and let an environment be created on it: the
 * connection pickers, the connection check and the bootstrap provider list all read this registry. It does NOT make
 * the in-process engine able to run a managed deployment. A managed environment is always a real-provider route
 * (`isRealProvider("zenith")`), so plan, apply, release and teardown run through the durable execution plane and
 * `direct-zenith.ts`; the step methods here refuse by design and say so, so nothing can reach them silently.
 *
 * Preflight reads the substrate's configuration only. It makes no cluster call and holds no credential.
 */
import type { CloudConnection, Environment, Manifest } from "@/lib/domain/types";
import type { ExportBundle, PreflightReport, ProviderAdapter, ProviderPlanStep, StepRuntime } from "@/lib/providers/types";

const NOT_IN_ENGINE =
  "A Zenith-managed environment is operated by the durable execution plane (plan, approval, apply, release, teardown), " +
  "not by the in-process engine. Deploy it through the normal deploy action once the platform is ready.";

export const ZENITH_PERMISSIONS: readonly string[] = [
  "Nothing of yours: the managed platform is the operator, so it needs no role, key, token or trust in any account you own.",
  "Each environment runs in its own namespace on the managed cluster, and its managed databases are created in the platform's database account.",
];

export const zenithProvider: ProviderAdapter = {
  id: "zenith",
  displayName: "Zenith managed platform",
  availability: "available",
  tagline: "Run on infrastructure Zenith operates for you. No cloud account, role or key to set up on your side.",
  regions: [{ id: "zenith-managed", label: "Zenith managed platform" }],

  accessExplanation: () => ({
    summary: "Zenith operates the infrastructure, so connecting grants nothing and stores no credential of yours.",
    permissions: [...ZENITH_PERMISSIONS],
  }),

  async preflight(_conn: CloudConnection): Promise<PreflightReport> {
    // Lazy: the engine registers this adapter at boot, and the composition pulls in the product port.
    const { defaultManagedSubstrate } = await import("@/lib/platform/zenith-managed");
    const status = defaultManagedSubstrate().status();
    const unready = Object.entries(status.description.components).filter(([, c]) => c.state !== "configured");
    return {
      ok: status.configured,
      checks: [{
        id: "zenith.substrate",
        label: status.configured ? "The managed substrate is configured" : "The managed substrate is not configured on this installation",
        status: status.configured ? "pass" : "fail",
        detail: status.configured ? "Configuration present; no cluster call was made." : unready.map(([name, c]) => `${name}: ${c.detail}`).join("; "),
        ...(status.configured ? {} : { fix: "The operator sets the ZENITH_MANAGED_* variables (docs/platform/MANAGED-PLATFORM.md)." }),
      }],
      permissions: [...ZENITH_PERMISSIONS],
    };
  },

  planSteps(_env: Environment, _next: Manifest): ProviderPlanStep[] {
    throw new Error(NOT_IN_ENGINE);
  },

  async executeStep(_rt: StepRuntime): Promise<void> {
    throw new Error(NOT_IN_ENGINE);
  },

  exportBundle(_env: Environment, _manifest: Manifest): ExportBundle {
    throw new Error("A Zenith-managed environment has no Terraform export: the platform renders and applies Kubernetes objects itself. Use the managed export of the rendered objects instead.");
  },
};
