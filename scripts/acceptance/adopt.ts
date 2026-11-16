/**
 * Tag adoption: putting `zenith:live-run=<runId>` on what Zenith created.
 *
 * The execution worker tags everything it creates `zenith:managed=true` and
 * `zenith:environment=<environmentId>` (plus workspace and project) but has no
 * way to add a per-run tag, so the harness adds it: every resource in an
 * environment THIS RUN created (its id is recorded in the run-state file the
 * moment the environment exists) and that does not already belong to a run.
 *
 * Adoption is deliberately narrow:
 *   - only environment ids the run itself recorded, never a name pattern;
 *   - only resources whose `zenith:environment` tag is exactly that id;
 *   - a resource that already carries a DIFFERENT `zenith:live-run` value is
 *     left alone and reported (it belongs to another run);
 *   - the only change made is adding one tag.
 *
 * Scenario A adopts repeatedly while the deploy runs, to keep the window
 * between "created" and "deletable by cleanup" short; cleanup adopts once more
 * before it lists, to recover from a run that died mid-deploy.
 *
 * A contract gap this works around (reported in the handoff): the execution
 * worker's `baseTags` has no hook for a per-run tag. With one, Zenith would tag
 * at creation and this module would only be a safety net.
 */
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient, TagResourcesCommand } from "@aws-sdk/client-resource-groups-tagging-api";
import { ENVIRONMENT_ID_PATTERN, TAG_ENVIRONMENT } from "@/lib/credentials/aws/naming";
import { TAG_LIVE_RUN, assertRunId } from "./safety";
import type { AwsAccess } from "./types";

export interface AdoptReport {
  adopted: string[];
  alreadyTagged: number;
  skipped: { arn: string; reason: string }[];
}

export interface AdoptInput {
  access: AwsAccess;
  runId: string;
  environmentIds: readonly string[];
  /** regions whose tagging index to search (global resources live in us-east-1) */
  regions: readonly string[];
  dryRun?: boolean;
}

const TAG_BATCH = 20;

export async function adoptEnvironmentResources(input: AdoptInput): Promise<AdoptReport> {
  assertRunId(input.runId);
  const report: AdoptReport = { adopted: [], alreadyTagged: 0, skipped: [] };
  for (const env of input.environmentIds) {
    if (!ENVIRONMENT_ID_PATTERN.test(env)) throw new Error(`"${env.slice(0, 40)}" is not a usable environment id; refusing to adopt by it.`);
  }
  for (const region of [...new Set(input.regions)]) {
    const tagging = input.access.client(ResourceGroupsTaggingAPIClient, { region });
    const toTag: string[] = [];
    for (const env of input.environmentIds) {
      let token: string | undefined;
      do {
        const page = await tagging.send(new GetResourcesCommand({ TagFilters: [{ Key: TAG_ENVIRONMENT, Values: [env] }], PaginationToken: token, ResourcesPerPage: 100 }));
        token = page.PaginationToken || undefined;
        for (const r of page.ResourceTagMappingList ?? []) {
          const arn = r.ResourceARN;
          if (!arn) continue;
          const tags = Object.fromEntries((r.Tags ?? []).flatMap((t) => (t.Key === undefined ? [] : [[t.Key, t.Value ?? ""] as const])));
          if (tags[TAG_ENVIRONMENT] !== env) {
            report.skipped.push({ arn, reason: "its environment tag does not match exactly" });
          } else if (tags[TAG_LIVE_RUN] === input.runId) {
            report.alreadyTagged++;
          } else if (tags[TAG_LIVE_RUN] !== undefined) {
            report.skipped.push({ arn, reason: `it already belongs to another run (${tags[TAG_LIVE_RUN]!.slice(0, 40)})` });
          } else if (!toTag.includes(arn)) {
            toTag.push(arn);
          }
        }
      } while (token);
    }
    if (input.dryRun) {
      report.adopted.push(...toTag);
      continue;
    }
    for (let i = 0; i < toTag.length; i += TAG_BATCH) {
      const batch = toTag.slice(i, i + TAG_BATCH);
      const out = await tagging.send(new TagResourcesCommand({ ResourceARNList: batch, Tags: { [TAG_LIVE_RUN]: input.runId } }));
      const failed = out.FailedResourcesMap ?? {};
      for (const arn of batch) {
        if (failed[arn]) report.skipped.push({ arn, reason: `tagging failed (${failed[arn]!.ErrorCode ?? "error"})` });
        else report.adopted.push(arn);
      }
    }
  }
  return report;
}
