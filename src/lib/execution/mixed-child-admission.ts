/** Internal native custody entry points. No default workflow or mixed execution flag is changed. */
import { platformDb } from "@/lib/controlplane/db";
import * as mixedChildIntents from "@/lib/controlplane/db/repos/mixed-child-intents";
import type { MixedChildIds, MixedChildCustody } from "@/lib/controlplane/db/repos/mixed-child-intents";

/** Only native IDs are accepted. Connection, plan, approval and backend metadata are read by the owning repository. */
export async function retainMixedChildCandidate(input: MixedChildIds): Promise<MixedChildCustody> {
  return mixedChildIntents.retain(await platformDb(), input);
}
/** Unsupported parent effects always refuse, including prepared rows with supplied approval-looking metadata. */
export async function reserveMixedChildStart(input: MixedChildIds): Promise<never> {
  return mixedChildIntents.reserve(await platformDb(), input);
}
