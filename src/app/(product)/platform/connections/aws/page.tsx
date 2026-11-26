/** Keyless AWS setup uses the existing human-only product actions. Only non-secret launch settings are serialized. */
import { loadPage } from "../../_lib/loaders";
import { EvidenceNote, PageState } from "../../_components/page-state";
import { loadCredentialsConfig } from "@/lib/credentials/config";
import { AwsConnectionFlow, type AwsLaunchSettings } from "./aws-flow";
export const dynamic = "force-dynamic";

/** The broker role ARN and whether a template is published are public facts (they appear in every customer's stack). */
function launchSettings(): AwsLaunchSettings {
  try {
    const config = loadCredentialsConfig();
    return { ...(config.awsBrokerPrincipalArn ? { brokerPrincipalArn: config.awsBrokerPrincipalArn } : {}), oneClickReady: Boolean(config.awsConnectionTemplateUrl) };
  } catch {
    return { oneClickReady: false };
  }
}

export default async function AwsConnectionPage() {
  const result = await loadPage(async () => null);
  if ("error" in result) return <PageState {...result} />;
  return <div className="space-y-5"><h1 className="app-page-title">Connect AWS</h1><EvidenceNote />
    <AwsConnectionFlow workspaceId={result.context.workspaceId} viewerRole={result.context.role} launch={launchSettings()} />
  </div>;
}
