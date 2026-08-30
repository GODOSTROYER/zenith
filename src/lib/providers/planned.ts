/**
 * Providers that do not exist yet. They are registered so the UI can show them
 * honestly — greyed out, with a tagline that says what is missing — rather
 * than implying capability Orrery does not have.
 *
 * Every method fails loudly and names the alternative. Nothing here pretends.
 *
 * Workstream A.
 */
import type { CloudConnection, Environment, Manifest, ProviderId } from "@/lib/domain/types";
import type {
  ExportBundle,
  PreflightReport,
  ProviderAdapter,
  ProviderPlanStep,
  StepRuntime,
} from "@/lib/providers/types";

interface PlannedSpec {
  id: ProviderId;
  displayName: string;
  tagline: string;
  regions: { id: string; label: string }[];
  /** what would be needed, said plainly */
  access: string;
}

const SPECS: PlannedSpec[] = [
  {
    id: "kubernetes",
    displayName: "Kubernetes",
    tagline:
      "Planned: deploy into a cluster you already run. Not built yet — Orrery cannot connect to a cluster today.",
    regions: [{ id: "in-cluster", label: "Your cluster" }],
    access:
      "A kubeconfig or service-account token scoped to one namespace, so Orrery could apply Deployments, Services and Ingresses there.",
  },
  {
    id: "gcp",
    displayName: "Google Cloud",
    tagline:
      "Planned: Cloud Run and Cloud SQL shaped deploys. Not built yet — no plan, no export, no connection.",
    regions: [
      { id: "us-central1", label: "Iowa (us-central1)" },
      { id: "europe-west1", label: "Belgium (europe-west1)" },
    ],
    access:
      "A workload-identity federation binding to a service account you create, with read-only inventory roles.",
  },
  {
    id: "azure",
    displayName: "Microsoft Azure",
    tagline:
      "Planned: Container Apps and Azure Database shaped deploys. Not built yet — no plan, no export, no connection.",
    regions: [
      { id: "eastus", label: "East US" },
      { id: "westeurope", label: "West Europe" },
    ],
    access:
      "An app registration in your tenant with Reader on one resource group, using federated credentials rather than a client secret.",
  },
];

function unavailable(spec: PlannedSpec, what: string): Error {
  return new Error(
    `${spec.displayName} is a planned provider, so Orrery cannot ${what} for it yet. ` +
      `Deploy to a Sandbox environment to see the full flow, or use the AWS provider to export runnable Terraform.`
  );
}

function build(spec: PlannedSpec): ProviderAdapter {
  return {
    id: spec.id,
    displayName: spec.displayName,
    availability: "planned",
    tagline: spec.tagline,
    regions: spec.regions,

    accessExplanation: () => ({
      summary: `Nothing is requested today — ${spec.displayName} support is not built. When it ships, the ask would be: ${spec.access}`,
      permissions: ["No access requested — provider not available"],
    }),

    async preflight(_conn: CloudConnection): Promise<PreflightReport> {
      return {
        ok: false,
        checks: [
          {
            id: `${spec.id}.availability`,
            label: `${spec.displayName} is not yet available`,
            status: "fail",
            detail: spec.tagline,
            fix: "Pick Sandbox to deploy now, or AWS to export Terraform for your own tooling.",
          },
        ],
        permissions: ["No access requested — provider not available"],
      };
    },

    planSteps(_env: Environment, _next: Manifest): ProviderPlanStep[] {
      throw unavailable(spec, "plan a deployment");
    },

    async executeStep(_rt: StepRuntime): Promise<void> {
      throw unavailable(spec, "run a deployment");
    },

    exportBundle(_env: Environment, _manifest: Manifest): ExportBundle {
      throw unavailable(spec, "generate an export bundle");
    },
  };
}

export const plannedProviders: ProviderAdapter[] = SPECS.map(build);
