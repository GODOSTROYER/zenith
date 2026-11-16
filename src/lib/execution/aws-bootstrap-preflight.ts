/** Supplemental readback only. Ordinary credential sessions and write admission are unchanged. */
import { readNativeAwsBootstrapReadiness, type AwsBootstrapReadiness } from "@/lib/platform/credentials";
import { loadExecContext, resolveConnection } from "./context";
import { StepFailedError } from "./errors";
import type { Runtime } from "./runtime";

/** The operation id is the existing activity input; all AWS scope comes from trusted stores. */
export async function observeAwsBootstrapReadiness(rt: Runtime, operationId: string): Promise<AwsBootstrapReadiness | undefined> {
  const ec = await loadExecContext(rt, operationId);
  const connection = await resolveConnection(rt, ec);
  if (connection.config.provider !== "aws") return undefined;
  if (ec.op.leaseScope !== `env:${ec.environmentId}` || !Number.isSafeInteger(ec.op.fenceToken) || ec.op.fenceToken! < 1)
    throw new StepFailedError("AWS bootstrap readiness requires the current native environment fence.");
  const { claims } = await rt.d.broker.issueGrant(ec.op.id,"worker",{scope:ec.op.leaseScope,fenceToken:ec.op.fenceToken!},
    {capability:"infrastructure.observe",durationSec:60});
  return readNativeAwsBootstrapReadiness(rt.d.credentials,{connectionId:connection.id,grant:claims});
}
