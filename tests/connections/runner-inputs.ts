import { CreateRunnerInput, type LifecycleProvider } from "@/lib/connections/schemas";
import type { ConnectionView } from "@/lib/connections/service";

export const runnerInputs = {
  aws: { accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/Observe", deployRoleArn: "arn:aws:iam::123456789012:role/Deploy" },
  gcp: { projectId: "runner-fixture-123", region: "us-central1", workloadIdentityProvider: "projects/123456789012/locations/global/workloadIdentityPools/zenith/providers/zenith-oidc", observeServiceAccount: "observe@runner-fixture-123.iam.gserviceaccount.com", deployServiceAccount: "deploy@runner-fixture-123.iam.gserviceaccount.com" },
  azure: { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", subscriptionId: "33333333-3333-4333-8333-333333333333", region: "eastus" },
  oci: { tenancyOcid: "ocid1.tenancy.oc1..aaaaaaaafixture", compartmentOcid: "ocid1.compartment.oc1..aaaaaaaafixture", region: "us-ashburn-1" },
  kubernetes: { server: "https://kubernetes.zenith.test", namespaces: ["customer", "jobs"] },
};
export const runnerInput = (provider: LifecycleProvider) => CreateRunnerInput.parse({ provider, mode: "runner", runnerId: "run_registered", ...runnerInputs[provider] });
export const runnerView = (provider: LifecycleProvider = "aws", patch: Partial<ConnectionView> = {}): ConnectionView => ({
  id: "conn_runner", provider, mode: "runner", label: "Customer runner", status: "verified", createdAt: "2026-10-08T00:00:00Z", productLinked: true, identity: { provider }, runnerId: "run_registered", ...patch,
});
