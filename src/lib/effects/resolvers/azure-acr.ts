/**
 * Independent readback of an ACR Tasks build launch (`build_launch`, provider `azure`).
 *
 * The launch pushes one image tag (`zn-<64 hex>`) derived from the exact launch identity. A SUCCEEDED run lists its
 * output images, so it can be matched by repository and tag. A run that is still queued/running, or that failed,
 * exposes no tag, so it cannot be attributed to this launch: if such runs exist after the effect was recorded the
 * answer is `unavailable` (never `absent`). Exactly one matching run is `present`; several is a `mismatch`.
 * Read only: ARM resource search for the registry, then the registry's run list.
 */
import type { AzureSession } from "@/lib/credentials/types";
import { armClient, type ArmResource } from "@/lib/providers/azure/arm";
import { API } from "@/lib/providers/azure/platform";
import type { EffectResolver, ReadbackFinding } from "../readback";
import type { EffectRecord } from "../types";

export interface AzureBuildResolverDeps {
  /** An authorized read-only Azure session for the effect's environment and region. */
  withSession<T>(effect: EffectRecord, signal: AbortSignal, fn: (session: AzureSession) => Promise<T>): Promise<T>;
}

const SOURCE = "azure.acr.runs";
const SKEW_MS = 2 * 60_000;
const TAG = /^zn-[a-f0-9]{64}$/;
const REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const REGISTRY_ADDRESS = /^[a-z_]+\/[A-Za-z0-9_.-]+$/;
const RUN_ID = /^[a-z0-9]{2,16}$/;
const str = (e: EffectRecord, k: string): string | undefined => (typeof e.target[k] === "string" ? (e.target[k] as string) : undefined);

interface RunRow { name?: string; properties?: Record<string, unknown> }

export function azureBuildLaunchResolver(deps: AzureBuildResolverDeps): EffectResolver {
  return {
    family: "build_launch",
    provider: "azure",
    async read({ effect, signal }): Promise<ReadbackFinding> {
      const tag = str(effect, "tag"), repository = str(effect, "repository"), registryAddress = str(effect, "registryAddress"), subscriptionId = str(effect, "subscriptionId");
      if (!tag || !TAG.test(tag) || !repository || !REPOSITORY.test(repository) || !registryAddress || !REGISTRY_ADDRESS.test(registryAddress) || !subscriptionId)
        return { outcome: "unavailable", source: SOURCE, facts: {}, reason: "The effect does not record the launch tag, repository and registry needed to read it back." };
      const since = Date.parse(effect.createdAt) - SKEW_MS;
      return deps.withSession(effect, signal, async (session): Promise<ReadbackFinding> => {
        if (session.subscriptionId.toLowerCase() !== subscriptionId.toLowerCase()) return { outcome: "unavailable", source: SOURCE, facts: {}, reason: "The brokered session is for a different subscription." };
        const arm = armClient(session, signal);
        const found = await arm.list<ArmResource>(`/subscriptions/${session.subscriptionId}/resources`, { apiVersion: "2021-04-01",
          query: { $filter: `tagName eq 'zenith:resource' and tagValue eq '${registryAddress.replace(/'/g, "''")}'` } });
        const registries = found.items.filter((r) => /^microsoft\.containerregistry\/registries$/i.test(String((r as { type?: string }).type ?? "")));
        if (found.truncated || registries.length !== 1) return { outcome: "unavailable", source: SOURCE, facts: { registries: registries.length }, reason: "The build registry could not be identified uniquely." };
        const runs = await arm.list<RunRow>(`${registries[0].id}/runs`, { apiVersion: API.containerRegistryRuns, query: { $filter: "RunType eq 'QuickBuild'" } }, 6);
        if (runs.truncated) return { outcome: "unavailable", source: SOURCE, facts: { runsListed: runs.items.length }, reason: "The run list was too long to read back to the dispatch time." };
        const matches: string[] = [];
        let unattributed = 0;
        for (const run of runs.items) {
          const props = run.properties ?? {};
          const created = Date.parse(String(props.createTime ?? ""));
          if (!Number.isFinite(created) || created < since) continue;
          const outputs = Array.isArray(props.outputImages) ? (props.outputImages as Record<string, unknown>[]) : [];
          if (props.status === "Succeeded" && outputs.some((o) => o.repository === repository && o.tag === tag)) {
            const runId = typeof props.runId === "string" ? props.runId : run.name;
            if (typeof runId === "string" && RUN_ID.test(runId)) matches.push(runId);
          } else if (!outputs.some((o) => o.tag === tag)) unattributed++;
        }
        const facts = { registry: (registries[0] as { name?: string }).name ?? null, runsListed: runs.items.length, matches: matches.length, unattributedRunsSinceDispatch: unattributed };
        const requestIds = runs.requestIds.slice(0, 1);
        if (matches.length === 1) return { outcome: "present", source: SOURCE, resourceId: matches[0], ...(requestIds.length ? { requestIds } : {}), facts };
        if (matches.length > 1) return { outcome: "mismatch", source: SOURCE, facts, reason: "More than one run pushed this launch's tag." };
        if (unattributed > 0) return { outcome: "unavailable", source: SOURCE, facts, reason: "Runs exist since the dispatch whose tag cannot be read (running or failed runs expose none), so absence cannot be shown." };
        return { outcome: "absent", source: SOURCE, facts };
      });
    },
  };
}
