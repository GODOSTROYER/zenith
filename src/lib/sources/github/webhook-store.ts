/** Database-only signed revocation. No webhook can create or restore a binding. */
import type { Sql } from "@/lib/controlplane/types";
import { GithubSourceError, numericId } from "./types";
import { isVerifiedGithubRevocation } from "./webhook";
import type { VerifiedGithubRevocation } from "./webhook";

export interface GithubWebhookFence { appId: string; installationId: number; generation: string }
interface Receipt { body_sha256: string; event: string; action: string; installation_id: string; repository_ids: string; revoked_count: number }
function scope(appId: string, installationId: number): void {
  if (!/^[1-9]\d{0,15}$/.test(appId) || !Number.isSafeInteger(Number(appId))) throw new GithubSourceError("invalid");
  numericId(installationId);
}
function generation(value: string): boolean {
  return /^(0|[1-9]\d{0,18})$/.test(value) && (value.length < 19 || value <= "9223372036854775807");
}
async function lockEpoch(tx: Sql, appId: string, installationId: number): Promise<string> {
  scope(appId, installationId);
  await tx.query(`insert into platform.github_webhook_installation_epochs (app_id, installation_id)
    values ($1, $2) on conflict (app_id, installation_id) do nothing`, [appId, installationId]);
  const rows = await tx.query<{ generation: string }>(`select generation::text as generation
    from platform.github_webhook_installation_epochs where app_id = $1 and installation_id = $2 for update`, [appId, installationId]);
  if (rows.length !== 1 || !generation(rows[0].generation)) throw new GithubSourceError("unavailable");
  return rows[0].generation;
}

/** Capture BEFORE external GitHub verification, including a first binding. */
export async function captureGithubWebhookFence(db: Sql, appId: string, installationId: number): Promise<GithubWebhookFence> {
  return db.tx(async tx => ({ appId, installationId, generation: await lockEpoch(tx, appId, installationId) }));
}
/** Call FIRST inside the SAME transaction as binding CAS and its audit insert. */
export async function assertGithubWebhookFence(tx: Sql, expected: GithubWebhookFence): Promise<void> {
  if (!generation(expected.generation)) throw new GithubSourceError("invalid");
  if (await lockEpoch(tx, expected.appId, expected.installationId) !== expected.generation) throw new GithubSourceError("conflict");
}

const projection = "body_sha256, event, action, installation_id::text as installation_id, repository_ids::text as repository_ids, revoked_count";
function same(receipt: Receipt, event: VerifiedGithubRevocation): boolean {
  return receipt.body_sha256 === event.bodySha256 && receipt.event === event.event && receipt.action === event.action
    && receipt.installation_id === String(event.installationId) && receipt.repository_ids === `{${event.repositoryIds.join(",")}}`;
}

export function createGithubWebhookStore(db: Sql, backendKind = (db as Sql & { readonly kind?: "postgres" | "pglite" }).kind) {
  if (backendKind !== "postgres" && backendKind !== "pglite") throw new GithubSourceError("unavailable");
  return {
    async apply(event: VerifiedGithubRevocation): Promise<{ duplicate: boolean; revokedCount: number }> {
      if (!isVerifiedGithubRevocation(event)) throw new GithubSourceError("refused");
      return db.tx(async tx => {
        const ids = `{${event.repositoryIds.join(",")}}`;
        const inserted = await tx.query(`insert into platform.github_webhook_deliveries
          (app_id, delivery_id, body_sha256, event, action, installation_id, repository_ids)
          values ($1, $2, $3, $4, $5, $6, $7::bigint[]) on conflict (app_id, delivery_id) do nothing returning delivery_id`,
        [event.appId, event.deliveryId, event.bodySha256, event.event, event.action, event.installationId, ids]);
        if (inserted.length === 0) {
          const previous = await tx.query<Receipt>(`select ${projection} from platform.github_webhook_deliveries
            where app_id = $1 and delivery_id = $2`, [event.appId, event.deliveryId]);
          if (previous.length !== 1 || !same(previous[0], event)) throw new GithubSourceError("conflict");
          return { duplicate: true, revokedCount: previous[0].revoked_count };
        }
        // Binding must take this same lock before its CAS. It also protects
        // first-binding callbacks, for which no binding version exists yet.
        await lockEpoch(tx, event.appId, event.installationId);
        const replay = await tx.query<Receipt>(`select ${projection} from platform.github_webhook_deliveries
          where app_id = $1 and body_sha256 = $2 and delivery_id <> $3 order by received_at, delivery_id limit 1`,
        [event.appId, event.bodySha256, event.deliveryId]);
        if (replay.length) {
          if (!same(replay[0], event)) throw new GithubSourceError("conflict");
          await tx.query(`update platform.github_webhook_deliveries set replayed = true, revoked_count = $3
            where app_id = $1 and delivery_id = $2`, [event.appId, event.deliveryId, replay[0].revoked_count]);
          return { duplicate: true, revokedCount: replay[0].revoked_count };
        }
        await tx.query(`update platform.github_webhook_installation_epochs set generation = generation + 1
          where app_id = $1 and installation_id = $2`, [event.appId, event.installationId]);
        // All cross-tenant authority is bounded by signed immutable provider
        // IDs. Names and URLs from the payload are never used as selectors.
        const candidates = await tx.query<{ workspace_id: string }>(`select workspace_id
          from platform.github_source_bindings where app_id = $1 and installation_id = $2
          and ($3::boolean or repository_id = any($4::bigint[])) order by workspace_id`,
        [event.appId, event.installationId, event.event === "installation", ids]);
        // Fixed global order: installation epoch, sorted tenant advisory locks,
        // then binding rows. PGlite serializes transactions in its engine.
        if (backendKind === "postgres") for (const row of candidates) await tx.query(
          "select pg_advisory_xact_lock(hashtextextended('zenith:github-binding:' || $1::text, 0))", [row.workspace_id]);
        const affected = await tx.query<{ workspace_id: string; active: boolean }>(`select workspace_id, revoked_at is null as active
          from platform.github_source_bindings where app_id = $1 and installation_id = $2
          and ($3::boolean or repository_id = any($4::bigint[])) order by workspace_id for update`,
        [event.appId, event.installationId, event.event === "installation", ids]);
        const actor = "github_webhook";
        let revokedCount = 0;
        for (const row of affected) {
          if (row.active) {
            const changed = await tx.query(`update platform.github_source_bindings
              set revoked_at = clock_timestamp(), revoked_by = $2, version = version + 1, updated_at = clock_timestamp()
              where workspace_id = $1 and app_id = $3 and installation_id = $4 and revoked_at is null returning version`,
            [row.workspace_id, actor, event.appId, event.installationId]);
            if (changed.length !== 1) throw new GithubSourceError("conflict");
            await tx.query(`insert into platform.github_binding_events
              (workspace_id, version, action, actor_id, app_id, installation_id, repository_id, owner, repo)
              select workspace_id, version, 'revoked', $2, app_id, installation_id, repository_id, owner, repo
              from platform.github_source_bindings where workspace_id = $1`, [row.workspace_id, actor]);
            revokedCount++;
          }
          // Includes pending callbacks on an already-revoked matching row.
          // Consumed callbacks must also carry the captured epoch into bind.
          await tx.query("delete from platform.github_install_intents where workspace_id = $1", [row.workspace_id]);
        }
        if (event.event === "installation") await tx.query(`delete from platform.github_install_intents
          where app_id = $1 and installation_id = $2`, [event.appId, event.installationId]);
        await tx.query(`update platform.github_webhook_deliveries set revoked_count = $3
          where app_id = $1 and delivery_id = $2`, [event.appId, event.deliveryId, revokedCount]);
        return { duplicate: false, revokedCount };
      });
    },
  };
}
