/**
 * The live-run sweeper: find everything a run created by tag and delete it.
 *
 *   npx tsx scripts/acceptance/cleanup.ts --run-id zlive-202609301200-ab12            # dry run
 *   npx tsx scripts/acceptance/cleanup.ts --run-id zlive-202609301200-ab12 --execute  # delete
 *   npx tsx scripts/acceptance/cleanup.ts --older-than 6 --execute                    # every zlive-* run older than 6 h
 *
 * DRY RUN IS THE DEFAULT. Nothing is deleted without `--execute`.
 *
 * Per run it does, in order:
 *   1. adopt: tag what the run's Zenith environments created with this run's
 *      `zenith:live-run` tag (recovers a run that died before it did);
 *   2. `tofu destroy` of the run's OpenTofu state when a state object exists,
 *      after checking that the destroy plan only touches this run's resources
 *      (`tofu-destroy.ts`);
 *   3. list every resource tagged `zenith:live-run=<runId>` (Resource Groups
 *      Tagging API, the run's region plus us-east-1 for global services);
 *   4. for each, in dependency order (ECS services, load balancers, target
 *      groups, RDS, ElastiCache, …, subnets, security groups, VPC): RE-READ its
 *      tags immediately before deleting and refuse anything that no longer
 *      carries this run's tag, refuse a name outside the run's naming, then call
 *      the type's deleter (`cleanup-handlers*.ts`);
 *   5. one more pass over anything that failed because something still
 *      depended on it;
 *   6. delete the Route53 records the run recorded (records cannot be tagged);
 *   7. list again and report what is still there.
 *
 * Resource types the harness has no deleter for are REPORTED (`unsupported`)
 * and left alone; a failed or refused deletion is reported and makes the run's
 * result not-ok. Cleanup never reports success it did not observe: `ok` is true
 * only when nothing failed, was refused, was unsupported or is still listed.
 *
 * Honest limits: the tagging index is eventually consistent (a deleted
 * resource can stay listed for minutes, and a just-created one can be missing),
 * so a run that dies right after creating something may need a second sweep;
 * deletion of an RDS instance skips the final snapshot, by design, for run-tagged
 * resources only; none of this has run against a real account.
 */
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { ChangeResourceRecordSetsCommand, ListResourceRecordSetsCommand, Route53Client } from "@aws-sdk/client-route-53";
import { TAG_LIVE_RUN, RUN_ID_PATTERN, assertRunId, assertRunTagged, lookupTags, runIdTime, LiveSafetyError } from "./safety";
import { adoptEnvironmentResources, type AdoptReport } from "./adopt";
import { HANDLERS, resolveHandler } from "./cleanup-handlers";
import { isInUse, parseArn, type Arn, type Handler, type HandlerCtx } from "./cleanup-util";
import { destroyRunWorkspace, type DestroyResult } from "./tofu-destroy";
import type { RunState } from "./run-state";
import type { AwsAccess } from "./types";
import { redactDeep } from "@/lib/credentials/redact";

export type ResourceStatus =
  | "would_delete"
  | "deleted"
  | "already_gone"
  | "covered_by_parent"
  | "not_listed_on_recheck"
  | "refused_tag_mismatch"
  | "refused_name_guard"
  | "refused_foreign_account"
  | "unsupported"
  | "failed";

export interface ResourceOutcome {
  arn: string;
  type: string;
  status: ResourceStatus;
  detail?: string;
}

export interface RunCleanup {
  runId: string;
  adopt?: { adopted: number; skipped: number; detail?: string };
  tofu: { status: DestroyResult["status"] | "skipped"; detail: string; deletes: number; refused: number }[];
  resources: ResourceOutcome[];
  dns: { record: string; status: "deleted" | "would_delete" | "not_found" | "refused" | "failed"; detail?: string }[];
  /** still listed after the sweep (execute mode only); the index can lag */
  remaining: string[];
  ok: boolean;
}

export interface CleanupReport {
  schema: 1;
  mode: "dry-run" | "execute";
  accountId: string;
  region: string;
  startedAt: string;
  finishedAt: string;
  selector: { runId: string } | { olderThanHours: number };
  /** tag values seen under `zenith:live-run` that are not run ids: never touched */
  ignoredTagValues: string[];
  runs: RunCleanup[];
  summary: { runs: number; found: number; deleted: number; wouldDelete: number; alreadyGone: number; coveredByParent: number; unverified: number; refused: number; unsupported: number; failed: number; remaining: number };
  ok: boolean;
}

export interface CleanupOptions {
  access: AwsAccess;
  selector: { runId: string } | { olderThanHours: number };
  /** default true: nothing is deleted unless this is false */
  dryRun?: boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** per-resource wait (default 20 min) and poll interval (default 10 s) */
  waitTimeoutMs?: number;
  pollMs?: number;
  stateBucket?: string;
  workspaceId?: string;
  stateKmsKeyArn?: string;
  /** run-state loader (default: none); gives environment ids, workspace id and DNS records */
  loadRunState?: (runId: string) => Promise<RunState | undefined>;
  /** default true */
  useTofu?: boolean;
  handlers?: readonly Handler[];
  destroy?: typeof destroyRunWorkspace;
  adopt?: typeof adoptEnvironmentResources;
  log?: (message: string) => void;
}

interface Listed {
  arn: string;
  region: string;
  tags: Record<string, string>;
}

const GLOBAL_REGION = "us-east-1";

export const regionsFor = (region: string): string[] => (region === GLOBAL_REGION ? [region] : [region, GLOBAL_REGION]);

/** All resources carrying `zenith:live-run` (optionally a specific value), across the given regions, deduplicated by ARN. */
export async function listTagged(access: AwsAccess, regions: readonly string[], value?: string): Promise<Listed[]> {
  const seen = new Map<string, Listed>();
  for (const region of regions) {
    const tagging = access.client(ResourceGroupsTaggingAPIClient, { region });
    let token: string | undefined;
    do {
      const page = await tagging.send(
        new GetResourcesCommand({ TagFilters: [{ Key: TAG_LIVE_RUN, ...(value !== undefined ? { Values: [value] } : {}) }], PaginationToken: token, ResourcesPerPage: 100 }),
      );
      token = page.PaginationToken || undefined;
      for (const r of page.ResourceTagMappingList ?? []) {
        if (!r.ResourceARN || seen.has(r.ResourceARN)) continue;
        const tags = Object.fromEntries((r.Tags ?? []).flatMap((t) => (t.Key === undefined ? [] : [[t.Key, t.Value ?? ""] as const])));
        seen.set(r.ResourceARN, { arn: r.ResourceARN, region, tags });
      }
    } while (token);
  }
  return [...seen.values()];
}

const typeOf = (arn: Arn): string => `${arn.service}:${arn.resource.split(/[/:]/)[0] ?? ""}`;

export async function cleanupRuns(opts: CleanupOptions): Promise<CleanupReport> {
  const now = opts.now ?? (() => new Date());
  const dryRun = opts.dryRun !== false;
  const log = opts.log ?? (() => undefined);
  const access = opts.access;
  const regions = regionsFor(access.region);
  const startedAt = now().toISOString();

  // Which runs?
  let runIds: string[];
  const ignored: string[] = [];
  if ("runId" in opts.selector) {
    runIds = [assertRunId(opts.selector.runId)];
  } else {
    const hours = opts.selector.olderThanHours;
    if (!Number.isFinite(hours) || hours < 0) throw new LiveSafetyError("run_id_invalid", "--older-than needs a number of hours (0 or more).");
    const cutoff = now().getTime() - hours * 3_600_000;
    const values = new Set((await listTagged(access, regions)).map((l) => l.tags[TAG_LIVE_RUN] ?? ""));
    runIds = [];
    for (const v of [...values].sort()) {
      const t = RUN_ID_PATTERN.test(v) ? runIdTime(v) : null;
      if (!t) ignored.push(v.slice(0, 60));
      else if (t.getTime() <= cutoff) runIds.push(v);
    }
  }

  const runs: RunCleanup[] = [];
  for (const runId of runIds) runs.push(await cleanRun(runId, { ...opts, dryRun, now, log, regions }));

  const all = runs.flatMap((r) => r.resources);
  const count = (s: ResourceStatus) => all.filter((r) => r.status === s).length;
  const refused = all.filter((r) => r.status.startsWith("refused_")).length;
  const summary = {
    runs: runs.length,
    found: all.length,
    deleted: count("deleted"),
    wouldDelete: count("would_delete"),
    alreadyGone: count("already_gone"),
    coveredByParent: count("covered_by_parent"),
    unverified: count("not_listed_on_recheck"),
    refused,
    unsupported: count("unsupported"),
    failed: count("failed"),
    remaining: runs.reduce((n, r) => n + r.remaining.length, 0),
  };
  return redactDeep({
    schema: 1,
    mode: dryRun ? "dry-run" : "execute",
    accountId: access.accountId,
    region: access.region,
    startedAt,
    finishedAt: now().toISOString(),
    selector: opts.selector,
    ignoredTagValues: ignored,
    runs,
    summary,
    ok: runs.every((r) => r.ok),
  });
}

type RunInput = CleanupOptions & { dryRun: boolean; now: () => Date; log: (m: string) => void; regions: string[] };

async function cleanRun(runId: string, o: RunInput): Promise<RunCleanup> {
  const { access, dryRun, regions, log } = o;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const handlers = o.handlers ?? HANDLERS;
  const out: RunCleanup = { runId, tofu: [], resources: [], dns: [], remaining: [], ok: true };
  const state = await o.loadRunState?.(runId);
  const envIds = state?.environmentIds ?? [];

  /* 1. adopt */
  if (envIds.length > 0) {
    try {
      const adopt = o.adopt ?? adoptEnvironmentResources;
      const report: AdoptReport = await adopt({ access, runId, environmentIds: envIds, regions, dryRun });
      out.adopt = { adopted: report.adopted.length, skipped: report.skipped.length, ...(report.skipped[0] ? { detail: `${report.skipped[0].arn}: ${report.skipped[0].reason}` } : {}) };
    } catch (err) {
      out.adopt = { adopted: 0, skipped: 0, detail: `adoption failed (${err instanceof Error ? err.name : "error"})` };
      out.ok = false;
    }
  }

  /* 2. tofu destroy, per environment with a state object */
  const workspaceId = state?.workspaceId ?? o.workspaceId;
  const stateBucket = state?.stateBucket ?? o.stateBucket;
  if (o.useTofu !== false) {
    if (envIds.length === 0) out.tofu.push({ status: "skipped", detail: "No environment ids were recorded for this run, so there is no state to find; native sweep only.", deletes: 0, refused: 0 });
    else if (!workspaceId || !stateBucket) out.tofu.push({ status: "skipped", detail: "The workspace id or state bucket is unknown (set ZENITH_LIVE_WORKSPACE_ID and ZENITH_LIVE_STATE_BUCKET); native sweep only.", deletes: 0, refused: 0 });
    else {
      const destroy = o.destroy ?? destroyRunWorkspace;
      for (const environmentId of envIds) {
        try {
          const r = await destroy({ access, runId, workspaceId, environmentId, region: access.region, stateBucket, stateKmsKeyArn: o.stateKmsKeyArn, dryRun });
          out.tofu.push({ status: r.status, detail: r.detail, deletes: r.deletes.length, refused: r.refused.length });
          if (r.status === "failed" || r.status === "refused") out.ok = false;
        } catch (err) {
          out.tofu.push({ status: "failed", detail: `Destroy threw (${err instanceof Error ? err.name : "error"}); attempting native sweep.`, deletes: 0, refused: 0 });
          out.ok = false;
        }
      }
    }
  } else {
    out.tofu.push({ status: "skipped", detail: "OpenTofu destroy was disabled for this sweep.", deletes: 0, refused: 0 });
  }

  /* 3-5. native sweep */
  const ctx: HandlerCtx = { access, runId, listedRegion: access.region, sleep, now: () => o.now().getTime(), waitTimeoutMs: o.waitTimeoutMs ?? 20 * 60_000, pollMs: o.pollMs ?? 10_000, log };
  const listed = await listTagged(access, regions, runId);
  const plan = listed
    .map((l) => ({ l, arn: parseArn(l.arn) }))
    .map(({ l, arn }) => ({ l, arn, resolved: arn ? resolveHandler(arn, handlers) : undefined }))
    .sort((a, b) => (a.resolved?.handler.rank ?? 10_000) - (b.resolved?.handler.rank ?? 10_000) || (a.l.arn < b.l.arn ? -1 : 1));

  const retry: typeof plan = [];
  const attempt = async (item: (typeof plan)[number], second: boolean): Promise<void> => {
    const { l, arn, resolved } = item;
    const type = arn ? typeOf(arn) : "unknown";
    const push = (status: ResourceStatus, detail?: string) => {
      const existing = out.resources.find((r) => r.arn === l.arn);
      const entry: ResourceOutcome = { arn: l.arn, type, status, ...(detail ? { detail } : {}) };
      if (existing) Object.assign(existing, entry);
      else out.resources.push(entry);
    };
    if (!arn || !resolved) {
      push("unsupported", "The harness has no deleter for this resource type; it was left alone and must be removed by hand.");
      return;
    }
    if (arn.account !== "" && arn.account !== access.accountId) {
      push("refused_foreign_account", "The ARN belongs to a different account than the run.");
      return;
    }
    if (dryRun) {
      push("would_delete", resolved.handler.id);
      return;
    }
    try {
      // The tag is re-read NOW, not trusted from the listing.
      const tagging = access.client(ResourceGroupsTaggingAPIClient, { region: l.region });
      const fresh = await lookupTags(tagging, l.arn);
      if (!fresh.listed) {
        push("not_listed_on_recheck", "The tagging index no longer lists it (deleted, or its tags were removed); left alone.");
        return;
      }
      try {
        assertRunTagged(fresh.tags, runId, l.arn);
      } catch {
        push("refused_tag_mismatch", `It no longer carries ${TAG_LIVE_RUN}=${runId}; not deleted.`);
        return;
      }
      const name = resolved.name;
      if (name !== undefined && name !== "" && !name.includes(runId) && !envIds.some((e) => name.includes(e))) {
        push("refused_name_guard", `Its name "${name.slice(0, 60)}" is outside the run's naming (zenith-${runId}-…); not deleted.`);
        return;
      }
      log(`Deleting ${resolved.handler.id} ${l.arn}`);
      const result = await resolved.handler.remove({ ...ctx, listedRegion: l.region }, arn, fresh.tags);
      push(result);
    } catch (err) {
      if (!second && isInUse(err)) {
        retry.push(item);
        push("failed", `Still in use; will retry once (${err instanceof Error ? err.name : "error"}).`);
        return;
      }
      push("failed", `${err instanceof Error ? err.name : "Error"}: ${err instanceof Error ? err.message.replace(/\s+/g, " ").slice(0, 240) : ""}`);
    }
  };

  for (const item of plan) await attempt(item, false);
  if (retry.length > 0 && !dryRun) {
    await sleep(ctx.pollMs);
    for (const item of retry) await attempt(item, true);
  }

  /* 6. DNS */
  if (state?.dnsRecords?.length) {
    for (const rec of state.dnsRecords) out.dns.push(await deleteDnsRecord(access, runId, rec, dryRun));
  }

  /* 7. what is still listed */
  if (!dryRun) {
    const after = await listTagged(access, regions, runId);
    out.remaining = after.map((a) => a.arn);
  }

  const badResource = out.resources.some((r) => r.status === "failed" || r.status === "unsupported" || r.status === "not_listed_on_recheck" || r.status.startsWith("refused_"));
  const badDns = out.dns.some((d) => d.status === "failed" || d.status === "refused");
  out.ok = out.ok && !badResource && !badDns && out.remaining.length === 0;
  return out;
}

/** Delete one recorded Route53 record, only if its name is this run's and the record still exists exactly as named. */
async function deleteDnsRecord(access: AwsAccess, runId: string, rec: NonNullable<RunState["dnsRecords"]>[number], dryRun: boolean): Promise<RunCleanup["dns"][number]> {
  const label = `${rec.type} ${rec.name}`;
  if (!rec.name.toLowerCase().startsWith(`${runId}.`)) return { record: label, status: "refused", detail: `The record name does not start with ${runId}.; not touched.` };
  try {
    const r53 = access.client(Route53Client, { region: GLOBAL_REGION });
    const name = rec.name.endsWith(".") ? rec.name : `${rec.name}.`;
    const page = await r53.send(new ListResourceRecordSetsCommand({ HostedZoneId: rec.zoneId, StartRecordName: name, StartRecordType: rec.type, MaxItems: 1 }));
    const found = page.ResourceRecordSets?.find((s) => s.Name?.toLowerCase() === name.toLowerCase() && s.Type === rec.type);
    if (!found) return { record: label, status: "not_found" };
    if (dryRun) return { record: label, status: "would_delete" };
    await r53.send(new ChangeResourceRecordSetsCommand({ HostedZoneId: rec.zoneId, ChangeBatch: { Changes: [{ Action: "DELETE", ResourceRecordSet: found }] } }));
    return { record: label, status: "deleted" };
  } catch (err) {
    return { record: label, status: "failed", detail: err instanceof Error ? err.name : "error" };
  }
}

/* ------------------------------ command line ------------------------------ */

// `npx tsx scripts/acceptance/cleanup.ts …` runs the sweeper. Importing this
// module (tests, aws-live.ts) never does: the check looks at the script tsx was
// started with, not at how the module system loaded this file.
if (process.argv[1] && /(?:^|[/\\])cleanup\.(?:ts|mts|js|mjs|cjs)$/.test(process.argv[1])) {
  void import("./cleanup-cli").then(async ({ runCleanupCli }) => {
    process.exitCode = await runCleanupCli(process.argv.slice(2));
  });
}
