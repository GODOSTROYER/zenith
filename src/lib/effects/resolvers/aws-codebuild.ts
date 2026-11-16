/**
 * Independent readback of an AWS CodeBuild launch (`build_launch`, provider `aws`).
 *
 * The build id of a lost StartBuild response is unknown, so the only independent
 * evidence is the project's own build list. A build is "this effect's build"
 * only when ALL of these hold: it belongs to the recorded project ARN, was
 * started at or after the effect was recorded, carries the recorded source
 * location and the single `ZENITH_SOURCE_DIGEST` variable, the executed
 * configuration digest equals the one recorded at launch, and no OTHER ledger
 * effect already owns it. Exactly one such build is `present`; none after the
 * whole window since dispatch was listed is `absent`; several, or a look-alike
 * whose executed configuration differs, is a `mismatch`.
 *
 * Read-only: ListBuildsForProject and BatchGetBuilds only.
 */
import { BatchGetBuildsCommand, ListBuildsForProjectCommand, type BatchGetBuildsCommandOutput, type Build, type CodeBuildClient, type ListBuildsForProjectCommandOutput } from "@aws-sdk/client-codebuild";
import { executedSettingsDigest } from "@/lib/providers/aws/drivers/compute/codebuild-builds";
import type { EffectResolver, ReadbackFinding } from "../readback";
import type { EffectRecord } from "../types";

export interface AwsBuildResolverDeps {
  /** An authorized read-only AWS session for the effect's environment and region. */
  withClient<T>(effect: EffectRecord, signal: AbortSignal, fn: (client: CodeBuildClient) => Promise<T>): Promise<T>;
  /** Build ids other ledger effects already own, so a neighbour's build is never adopted. */
  otherBuildIds(effect: EffectRecord): Promise<ReadonlySet<string>>;
  maxPages?: number;
}

const SOURCE = "aws.codebuild.list-builds";
const SKEW_MS = 2 * 60_000;

function str(effect: EffectRecord, key: string): string | undefined {
  const v = effect.target[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function awsBuildLaunchResolver(deps: AwsBuildResolverDeps): EffectResolver {
  return {
    family: "build_launch",
    provider: "aws",
    async read({ effect, signal }): Promise<ReadbackFinding> {
      const projectName = str(effect, "projectName"), projectArn = str(effect, "projectArn"), bucket = str(effect, "sourceBucket"),
        key = str(effect, "sourceKey"), sourceDigest = str(effect, "sourceDigest"), executed = str(effect, "executedSettingsDigest"),
        region = str(effect, "region"), accountId = str(effect, "accountId");
      if (!projectName || !projectArn || !bucket || !key || !sourceDigest || !executed || !region || !accountId)
        return { outcome: "unavailable", source: SOURCE, facts: {}, reason: "The effect does not record enough build identity to read it back." };
      const since = Date.parse(effect.createdAt) - SKEW_MS;
      const others = await deps.otherBuildIds(effect);
      const maxPages = Math.max(1, Math.min(deps.maxPages ?? 5, 20));
      return deps.withClient(effect, signal, async (cb) => {
        const matches: Build[] = [];
        let lookalikes = 0, listed = 0, reachedDispatch = false, requestId: string | undefined;
        let token: string | undefined;
        for (let page = 0; page < maxPages && !reachedDispatch; page++) {
          const ids: ListBuildsForProjectCommandOutput = await cb.send(new ListBuildsForProjectCommand({ projectName, sortOrder: "DESCENDING", ...(token ? { nextToken: token } : {}) }), { abortSignal: signal });
          const batch: string[] = ids.ids ?? [];
          for (let i = 0; i < batch.length; i += 100) {
            const got: BatchGetBuildsCommandOutput = await cb.send(new BatchGetBuildsCommand({ ids: batch.slice(i, i + 100) }), { abortSignal: signal });
            requestId = got.$metadata?.requestId ?? requestId;
            for (const build of got.builds ?? [] as Build[]) {
              listed++;
              const started = build.startTime?.getTime();
              if (started === undefined || started < since) { reachedDispatch = true; continue; }
              if (!build.id || others.has(build.id) || build.arn !== `arn:aws:codebuild:${region}:${accountId}:build/${build.id}` || build.projectName !== projectName) continue;
              const vars = build.environment?.environmentVariables?.filter((v: { name?: string }) => v.name === "ZENITH_SOURCE_DIGEST");
              if (build.source?.type !== "S3" || build.source.location !== `${bucket}/${key}` || vars?.length !== 1 || vars[0].value !== sourceDigest) continue;
              let sameConfig = false;
              try { sameConfig = executedSettingsDigest(build) === executed; } catch { sameConfig = false; }
              if (sameConfig) matches.push(build); else lookalikes++;
            }
          }
          token = ids.nextToken;
          if (!token) reachedDispatch = true;
        }
        const facts = { project: projectName, buildsListed: listed, matches: matches.length, lookalikes, reachedDispatchTime: reachedDispatch };
        if (matches.length === 1 && lookalikes === 0) {
          const b = matches[0];
          return { outcome: "present", source: SOURCE, resourceId: b.id!, ...(requestId ? { requestIds: [requestId] } : {}), facts: { ...facts, buildStatus: b.buildStatus ?? null, startedAt: b.startTime?.toISOString() ?? null } };
        }
        if (matches.length > 1 || lookalikes > 0)
          return { outcome: "mismatch", source: SOURCE, facts, reason: matches.length > 1 ? "More than one build matches this launch." : "A build with this source exists but its executed configuration differs." };
        if (!reachedDispatch) return { outcome: "unavailable", source: SOURCE, facts, reason: "The build list was too long to read back to the dispatch time." };
        return { outcome: "absent", source: SOURCE, facts };
      });
    },
  };
}
