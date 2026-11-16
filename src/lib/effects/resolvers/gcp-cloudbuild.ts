/**
 * Independent readback of a Cloud Build launch (`build_launch`, provider `gcp`).
 *
 * Every launch carries a tag (`zenith-op-<12 hex>`) derived from the exact launch identity, and Cloud Build lists
 * builds by tag. Exactly one build with the tag is `present`; none is `absent`; several is a `mismatch`. Read only:
 * one GET on the project's builds with the brokered session of the effect's environment.
 */
import type { GcpSession } from "@/lib/credentials/types";
import type { EffectResolver, ReadbackFinding } from "../readback";
import type { EffectRecord } from "../types";

export interface GcpBuildResolverDeps {
  /** An authorized read-only GCP session for the effect's environment and region. */
  withSession<T>(effect: EffectRecord, signal: AbortSignal, fn: (session: GcpSession) => Promise<T>): Promise<T>;
}

const SOURCE = "gcp.cloudbuild.list-by-tag";
const TAG = /^zenith-op-[a-f0-9]{12}$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION = /^[a-z]+-[a-z]+[0-9]+$|^global$/;
const BUILD_ID = /^[a-f0-9-]{8,64}$/;

const str = (e: EffectRecord, k: string): string | undefined => (typeof e.target[k] === "string" ? (e.target[k] as string) : undefined);

interface BuildRow { id: string; status?: string; tags?: string[]; createTime?: string }

export function gcpBuildLaunchResolver(deps: GcpBuildResolverDeps): EffectResolver {
  return {
    family: "build_launch",
    provider: "gcp",
    async read({ effect, signal }): Promise<ReadbackFinding> {
      const tag = str(effect, "tag"), projectId = str(effect, "projectId"), region = str(effect, "region");
      if (!tag || !TAG.test(tag) || !projectId || !PROJECT.test(projectId) || !region || !REGION.test(region))
        return { outcome: "unavailable", source: SOURCE, facts: {}, reason: "The effect does not record the launch tag, project and region needed to read it back." };
      const url = `https://cloudbuild.googleapis.com/v1/projects/${projectId}/locations/${region}/builds?pageSize=20&filter=${encodeURIComponent(`tags="${tag}"`)}`;
      return deps.withSession(effect, signal, async (session): Promise<ReadbackFinding> => {
        if (session.projectId !== projectId) return { outcome: "unavailable", source: SOURCE, facts: {}, reason: "The brokered session is for a different project." };
        const res = await session.authorizedFetch(url, { signal });
        if (!res.ok) return { outcome: "unavailable", source: SOURCE, facts: { httpStatus: res.status }, reason: "Cloud Build could not be read." };
        const requestId = res.headers.get("x-goog-request-id") ?? undefined;
        let body: { builds?: unknown; nextPageToken?: unknown };
        try { body = (await res.json()) as typeof body; } catch { return { outcome: "unavailable", source: SOURCE, facts: {}, reason: "Cloud Build returned an unreadable answer." }; }
        const builds = (Array.isArray(body.builds) ? (body.builds as unknown[]) : []).filter((b): b is BuildRow =>
          !!b && typeof b === "object" && typeof (b as BuildRow).id === "string" && BUILD_ID.test((b as BuildRow).id) && Array.isArray((b as BuildRow).tags) && ((b as BuildRow).tags as string[]).includes(tag));
        const facts = { tag, matches: builds.length, moreResults: body.nextPageToken !== undefined };
        if (builds.length === 1 && body.nextPageToken === undefined)
          return { outcome: "present", source: SOURCE, resourceId: builds[0].id, ...(requestId ? { requestIds: [requestId] } : {}), facts: { ...facts, buildStatus: builds[0].status ?? null, createdAt: builds[0].createTime ?? null } };
        if (builds.length > 0) return { outcome: "mismatch", source: SOURCE, facts, reason: "More than one build carries this launch tag." };
        return { outcome: "absent", source: SOURCE, facts };
      });
    },
  };
}
