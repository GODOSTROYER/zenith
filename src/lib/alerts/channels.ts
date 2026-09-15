/**
 * Alert delivery channels: where an alert goes besides the screen.
 *
 * A channel belongs to the workspace, not a project — an operator configures
 * `#ops` once, and every rule in every project can use it. Rules select
 * channels by id; a rule that selects none (the default) uses every enabled
 * channel, which is the behaviour somebody who just added their first webhook
 * expects.
 *
 * Storage is `db().settings.alertChannels`. `settings` is
 * `Record<string, unknown>` in the Database type, so this is additive: no
 * schema change, and a store written before channels existed loads fine.
 *
 * Two secrets live here and neither ever leaves the server:
 *  - `secret`, the HMAC key for a signed webhook;
 *  - the token inside a Slack incoming-webhook URL, which is the whole URL's
 *    reason to be secret. `maskTarget` keeps it out of every response.
 */
import { db, flush, flushPendingAsync, isPostgres, q, save } from "@/lib/db/store";
import type { AlertChannel, AlertChannelKind, AlertRule } from "@/lib/domain/types";
import {
  putSecret,
  putSecretAsync,
  readSecretValue,
  readSecretValueAsync,
  removeSecret,
  removeSecretAsync,
  secretStoreState,
} from "@/lib/secrets";

/** Additive fields understood by the alert store; old rows omit both refs. */
export type StoredAlertChannel = AlertChannel & {
  secretRef?: string;
  targetSecretRef?: string;
};

/** Stable, workspace-scoped identity for a channel's signing key. */
export const alertChannelSecretRef = (channelId: string): string =>
  `vault:alert-channel/${channelId}/SIGNING_SECRET`;

/** Stable, workspace-scoped identity for a credential-bearing target URL. */
export const alertChannelTargetSecretRef = (channelId: string): string =>
  `vault:alert-channel/${channelId}/TARGET_URL`;

/**
 * A credential fault, as opposed to a bad moment.
 *
 * Every throw in this file's read paths is one of these: a missing
 * `ZENITH_SECRET_KEY`, a reference this channel does not own, a ciphertext that
 * will not open, a legacy row on a store that cannot migrate it. None of them
 * changes between two attempts a second apart, so `deliver.ts` turns this class
 * into a permanent delivery failure instead of spending the retry ladder on it.
 */
export class ChannelCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelCredentialError";
  }
}

/**
 * What an operator has to do about a legacy row that this store cannot migrate.
 * One sentence, so the delivery record, the test-send and the migration script
 * all say the same thing — and it names the channel, because "some channel is
 * blocked" is not an instruction.
 */
export const postgresLegacyChannelProblem = (channel: AlertChannel, what: string): string =>
  `This channel ("${channel.name}", ${channel.id}) still has a ${what}, and a Postgres install cannot migrate it in place: the secret row and the channel row have no shared transaction. Delivery stays blocked until an operator runs the coordinated migration (docs/hosted/PROVIDERS.md → "Alert channel secrets"), or resets this channel's credential under Settings → Alerts, which rewrites it in the encrypted form.`;

function assertCanonicalCredentialRefs(channel: AlertChannel): void {
  const stored = channel as StoredAlertChannel;
  const signingRef = alertChannelSecretRef(channel.id);
  const targetRef = alertChannelTargetSecretRef(channel.id);
  // The first migration used `secretRef` for a Slack URL. Preserve that exact
  // legacy shape, but never accept an arbitrary same-workspace reference.
  if (stored.targetSecretRef && stored.targetSecretRef !== targetRef)
    throw new ChannelCredentialError("The channel's webhook target reference is not owned by this channel; reset the credential before sending.");
  if (stored.secretRef && stored.secretRef !== signingRef)
    throw new ChannelCredentialError("The channel's signing credential reference is not owned by this channel; reset the credential before sending.");
}

/**
 * Open one sealed credential, turning every way that can fail into a
 * `ChannelCredentialError`.
 *
 * `readSecretValue*` throws a plain `Error` when the ciphertext will not open —
 * a rotated or missing `ZENITH_SECRET_KEY`, an altered store file, a row lifted
 * from another tenant whose AAD no longer matches. That is a credential fault
 * like any other here, and classifying it as one is what keeps delivery from
 * spending three attempts and two backoffs on a byte that will never decrypt.
 */
function openSecret(workspaceId: string, ref: string, missing: string): string {
  let value: string | undefined;
  try {
    value = readSecretValue(workspaceId, ref);
  } catch (error) {
    throw new ChannelCredentialError(error instanceof Error ? error.message : String(error));
  }
  if (value === undefined) throw new ChannelCredentialError(missing);
  return value;
}

async function openSecretAsync(workspaceId: string, ref: string, missing: string): Promise<string> {
  let value: string | undefined;
  try {
    value = await readSecretValueAsync(workspaceId, ref);
  } catch (error) {
    throw new ChannelCredentialError(error instanceof Error ? error.message : String(error));
  }
  if (value === undefined) throw new ChannelCredentialError(missing);
  return value;
}

/** Read a signing key without exposing it to callers that only need metadata. */
export function channelSecret(channel: AlertChannel): string | undefined {
  const stored = channel as StoredAlertChannel;
  assertCanonicalCredentialRefs(channel);
  if (stored.secretRef) {
    return openSecret(channel.workspaceId, stored.secretRef, "The channel's signing secret is missing from Zenith's secret store; set it again before sending.");
  }
  // Legacy plaintext is intentionally not a usable fallback. channelTable()
  // migrates it when the key is configured; direct callers that already hold a
  // just-created/legacy object get the same idempotent migration.
  if (channel.secret !== undefined) {
    if (!secretStoreState().configured)
      throw new ChannelCredentialError("This channel still has a legacy plaintext signing secret. Configure ZENITH_SECRET_KEY and reload it before sending.");
    if (isPostgres())
      throw new ChannelCredentialError(postgresLegacyChannelProblem(channel, "legacy plaintext signing secret"));
    setChannelSecret(channel, channel.secret, "system:alert-channel-migration");
    save();
    flush();
    return readSecretValue(channel.workspaceId, (channel as StoredAlertChannel).secretRef!);
  }
  return undefined;
}

/** Resolve a Slack URL credential without exposing it to metadata callers. */
export function channelTarget(channel: AlertChannel): string {
  const stored = channel as StoredAlertChannel;
  assertCanonicalCredentialRefs(channel);
  if (channel.kind === "email") return channel.target;
  if (stored.targetSecretRef) {
    return openSecret(channel.workspaceId, stored.targetSecretRef, "The channel's webhook target is missing from Zenith's secret store; set it again before sending.");
  }
  // Rows written by the first hardening slice used secretRef for Slack URLs.
  // Resolve that shape only while migration is able to move it to the target
  // namespace; it is never treated as a generic plaintext fallback.
  if (channel.kind === "slack" && stored.secretRef) {
    return openSecret(channel.workspaceId, stored.secretRef, "The channel's Slack webhook URL is missing from Zenith's secret store; set it again before sending.");
  }
  if (secretStoreState().configured && channel.target) {
    if (isPostgres())
      throw new ChannelCredentialError(postgresLegacyChannelProblem(channel, "plaintext webhook target"));
    setChannelTargetSecret(channel, channel.target, "system:alert-channel-migration");
    save();
    flush();
    return readSecretValue(channel.workspaceId, (channel as StoredAlertChannel).targetSecretRef!)!;
  }
  throw new ChannelCredentialError("This channel still has a plaintext webhook target. Configure ZENITH_SECRET_KEY and reload it before sending.");
}

/** Awaitable signing-key lookup for alert delivery. */
export async function channelSecretAsync(channel: AlertChannel): Promise<string | undefined> {
  const stored = channel as StoredAlertChannel;
  assertCanonicalCredentialRefs(channel);
  if (stored.secretRef) {
    return openSecretAsync(channel.workspaceId, stored.secretRef, "The channel's signing secret is missing from Zenith's secret store; set it again before sending.");
  }
  if (channel.secret !== undefined) {
    if (!secretStoreState().configured)
      throw new ChannelCredentialError("This channel still has a legacy plaintext signing secret. Configure ZENITH_SECRET_KEY and reload it before sending.");
    if (isPostgres())
      throw new ChannelCredentialError(postgresLegacyChannelProblem(channel, "legacy plaintext signing secret"));
    await setChannelSecretAsync(channel, channel.secret, "system:alert-channel-migration");
    save();
    await flushPendingAsync();
    return readSecretValueAsync(channel.workspaceId, (channel as StoredAlertChannel).secretRef!);
  }
  return undefined;
}

/** Awaitable target lookup for alert delivery. */
export async function channelTargetAsync(channel: AlertChannel): Promise<string> {
  const stored = channel as StoredAlertChannel;
  assertCanonicalCredentialRefs(channel);
  if (channel.kind === "email") return channel.target;
  if (stored.targetSecretRef) {
    return openSecretAsync(channel.workspaceId, stored.targetSecretRef, "The channel's webhook target is missing from Zenith's secret store; set it again before sending.");
  }
  if (channel.kind === "slack" && stored.secretRef) {
    return openSecretAsync(channel.workspaceId, stored.secretRef, "The channel's Slack webhook URL is missing from Zenith's secret store; set it again before sending.");
  }
  if (secretStoreState().configured && channel.target) {
    if (isPostgres())
      throw new ChannelCredentialError(postgresLegacyChannelProblem(channel, "plaintext webhook target"));
    await setChannelTargetSecretAsync(channel, channel.target, "system:alert-channel-migration");
    save();
    await flushPendingAsync();
    return openSecretAsync(channel.workspaceId, (channel as StoredAlertChannel).targetSecretRef!, "The channel's webhook target is missing from Zenith's secret store; set it again before sending.");
  }
  throw new ChannelCredentialError("This channel still has a plaintext webhook target. Configure ZENITH_SECRET_KEY and reload it before sending.");
}

async function snapshotChannelCredentialsAsync(channel: AlertChannel): Promise<ChannelCredentialSnapshot> {
  const stored = channel as StoredAlertChannel;
  assertCanonicalCredentialRefs(channel);
  return {
    target: channel.target,
    legacySecret: channel.secret,
    secretRef: stored.secretRef,
    targetSecretRef: stored.targetSecretRef,
    secret: stored.secretRef ? await readSecretValueAsync(channel.workspaceId, stored.secretRef) : undefined,
    targetValue: stored.targetSecretRef
      ? await readSecretValueAsync(channel.workspaceId, stored.targetSecretRef)
      : undefined,
  };
}

async function restoreChannelCredentialsAsync(channel: AlertChannel, before: ChannelCredentialSnapshot): Promise<void> {
  const stored = channel as StoredAlertChannel;
  const currentRefs = new Set([stored.secretRef, stored.targetSecretRef].filter(Boolean) as string[]);
  const previousRefs = new Set([before.secretRef, before.targetSecretRef].filter(Boolean) as string[]);
  for (const ref of currentRefs) if (!previousRefs.has(ref)) await removeSecretAsync(channel.workspaceId, ref);
  if (before.secretRef && before.secret !== undefined)
    await putSecretAsync(channel.workspaceId, before.secretRef, before.secret, "system:alert-channel-rollback");
  if (before.targetSecretRef && before.targetValue !== undefined)
    await putSecretAsync(channel.workspaceId, before.targetSecretRef, before.targetValue, "system:alert-channel-rollback");
  if (before.secretRef) stored.secretRef = before.secretRef; else delete stored.secretRef;
  if (before.targetSecretRef) stored.targetSecretRef = before.targetSecretRef; else delete stored.targetSecretRef;
  if (before.legacySecret !== undefined) channel.secret = before.legacySecret; else delete channel.secret;
  channel.target = before.target;
}

export async function setChannelSecretAsync(channel: AlertChannel, value: string | undefined, by: string): Promise<void> {
  const stored = channel as StoredAlertChannel;
  assertCanonicalCredentialRefs(channel);
  const ref = alertChannelSecretRef(channel.id);
  if (value) {
    await putSecretAsync(channel.workspaceId, ref, value, by);
    stored.secretRef = ref;
  } else if (stored.secretRef) {
    await removeSecretAsync(channel.workspaceId, stored.secretRef);
    delete stored.secretRef;
  }
  delete channel.secret;
}

export async function setChannelTargetSecretAsync(channel: AlertChannel, value: string, by: string): Promise<void> {
  const stored = channel as StoredAlertChannel;
  assertCanonicalCredentialRefs(channel);
  const ref = alertChannelTargetSecretRef(channel.id);
  const parsed = new URL(value);
  await putSecretAsync(channel.workspaceId, ref, value, by);
  stored.targetSecretRef = ref;
  channel.target = channel.kind === "slack"
    ? parsed.origin
    : `${parsed.origin}${parsed.pathname !== "/" || parsed.search ? "/…" : ""}`;
}

/** Async counterpart used by action execution and Postgres-backed delivery. */
export async function setChannelCredentialsAsync(
  channel: AlertChannel,
  update: ChannelCredentialUpdate,
  by: string
): Promise<void> {
  const before = await snapshotChannelCredentialsAsync(channel);
  try {
    if (Object.prototype.hasOwnProperty.call(update, "target"))
      await setChannelTargetSecretAsync(channel, update.target!, by);
    if (Object.prototype.hasOwnProperty.call(update, "signing"))
      await setChannelSecretAsync(channel, update.signing, by);
  } catch (error) {
    try { await restoreChannelCredentialsAsync(channel, before); }
    catch { throw new Error("The alert credentials could not be updated or rolled back safely. Inspect the secret store before retrying."); }
    throw error;
  }
}

export async function removeChannelSecretsAsync(channel: AlertChannel): Promise<void> {
  const before = await snapshotChannelCredentialsAsync(channel);
  const stored = channel as StoredAlertChannel;
  try {
    const refs = new Set([stored.secretRef, stored.targetSecretRef].filter(Boolean) as string[]);
    for (const ref of refs) await removeSecretAsync(channel.workspaceId, ref);
    delete stored.secretRef; delete stored.targetSecretRef; delete channel.secret;
  } catch (error) {
    try { await restoreChannelCredentialsAsync(channel, before); }
    catch { throw new Error("The alert credentials could not be deleted or rolled back safely; inspect the secret store before retrying."); }
    throw error;
  }
}

export const channelHasSecret = (channel: AlertChannel): boolean => {
  const stored = channel as StoredAlertChannel;
  if (channel.kind === "slack") {
    if (stored.targetSecretRef || stored.secretRef) return true;
    try {
      const url = new URL(channel.target);
      return url.pathname !== "/" || !!url.search;
    } catch {
      return false;
    }
  }
  return !!stored.secretRef || !!channel.secret;
};

type ChannelCredentialUpdate = {
  target?: string;
  signing?: string | undefined;
};

type ChannelCredentialSnapshot = {
  target: string;
  legacySecret: string | undefined;
  secretRef: string | undefined;
  targetSecretRef: string | undefined;
  secret: string | undefined;
  targetValue: string | undefined;
};

function snapshotChannelCredentials(channel: AlertChannel): ChannelCredentialSnapshot {
  const stored = channel as StoredAlertChannel;
  assertCanonicalCredentialRefs(channel);
  return {
    target: channel.target,
    legacySecret: channel.secret,
    secretRef: stored.secretRef,
    targetSecretRef: stored.targetSecretRef,
    secret: stored.secretRef ? readSecretValue(channel.workspaceId, stored.secretRef) : undefined,
    targetValue: stored.targetSecretRef
      ? readSecretValue(channel.workspaceId, stored.targetSecretRef)
      : undefined,
  };
}

function restoreChannelCredentials(channel: AlertChannel, before: ChannelCredentialSnapshot): void {
  const stored = channel as StoredAlertChannel;
  const currentRefs = new Set([stored.secretRef, stored.targetSecretRef].filter(Boolean) as string[]);
  const previousRefs = new Set([before.secretRef, before.targetSecretRef].filter(Boolean) as string[]);
  for (const ref of currentRefs) {
    if (!previousRefs.has(ref)) removeSecret(channel.workspaceId, ref);
  }
  if (before.secretRef && before.secret !== undefined)
    putSecret(channel.workspaceId, before.secretRef, before.secret, "system:alert-channel-rollback");
  if (before.targetSecretRef && before.targetValue !== undefined)
    putSecret(channel.workspaceId, before.targetSecretRef, before.targetValue, "system:alert-channel-rollback");
  if (before.secretRef) stored.secretRef = before.secretRef;
  else delete stored.secretRef;
  if (before.targetSecretRef) stored.targetSecretRef = before.targetSecretRef;
  else delete stored.targetSecretRef;
  if (before.legacySecret !== undefined) channel.secret = before.legacySecret;
  else delete channel.secret;
  channel.target = before.target;
}

/**
 * Apply both independent channel credentials as one logical mutation.
 *
 * ## This is a two-authority write, and it is compensating, not atomic
 *
 * A channel credential lives in the **secret store** (`src/lib/secrets`) while
 * the reference to it lives in the **product store** (`db().settings`). There
 * is no transaction that spans the two (ADR D-4), so exactly three outcomes
 * exist and all three are handled here or by the caller:
 *
 *  1. Both writes succeed — the normal case.
 *  2. The *second* secret write fails. Compensated below: the first write is
 *     undone and the previous values are put back, and the function throws
 *     **before** the caller reaches `save()`, so no channel snapshot referring
 *     to a half-written pair is ever persisted.
 *  3. The secret writes succeed and the caller's own `save()`/flush of the
 *     settings row then fails — a crash, a 409, a disk error. This one is
 *     **not compensated and cannot be**: the process may be gone. The
 *     observable result is an **orphaned secret row** under this channel's
 *     canonical reference, holding a value nothing points at.
 *
 * Outcome 3 is safe but not self-healing, and it is deliberately left that way:
 *
 *  - It cannot leak. The orphan is sealed under AAD `"<workspaceId> <ref>"` and
 *    the reference is derived from the channel id, so only this channel can
 *    ever name it, and only this workspace can ever open it.
 *  - It cannot be used. Delivery reads the reference from the channel row; a
 *    row that was never saved has none, so the channel fails closed.
 *  - It is reconciled by a *re-run*, not by a sweep. Both `setChannelSecret`
 *    and `setChannelTargetSecret` write the canonical reference for the channel
 *    id, so repeating the operation (or `npm run migrate:alert-secrets --
 *    --apply`, which journals each channel in
 *    `settings.pendingAlertSecretMigrations` before touching it) **overwrites**
 *    the orphan rather than adding a second one. The journal entry is what
 *    tells an operator the pair was mid-flight; `reconcilePendingAlertSecretMigrationsAsync`
 *    retains exactly those entries whose channel still looks unmigrated.
 *  - Deleting the channel removes the orphan too, because `removeChannelSecrets`
 *    deletes by canonical reference rather than by what the row happens to say.
 *
 * The runbook entry for this is in docs/hosted/PROVIDERS.md → "Alert channel
 * secrets"; the failure test is `tests/alerts/migrate-alert-secrets.test.ts`
 * ("an orphaned secret is reconciled by re-running the migration").
 */
export function setChannelCredentials(
  channel: AlertChannel,
  update: ChannelCredentialUpdate,
  by: string
): void {
  const before = snapshotChannelCredentials(channel);
  try {
    if (Object.prototype.hasOwnProperty.call(update, "target"))
      setChannelTargetSecret(channel, update.target!, by);
    if (Object.prototype.hasOwnProperty.call(update, "signing"))
      setChannelSecret(channel, update.signing, by);
  } catch (error) {
    try {
      restoreChannelCredentials(channel, before);
    } catch {
      throw new Error(
        "The alert credentials could not be updated or rolled back safely. No channel snapshot was saved; inspect the secret store before retrying."
      );
    }
    throw error;
  }
}

/** Store or clear a channel signing key without leaving a plaintext row. */
export function setChannelSecret(channel: AlertChannel, value: string | undefined, by: string): void {
  const stored = channel as StoredAlertChannel;
  assertCanonicalCredentialRefs(channel);
  const ref = alertChannelSecretRef(channel.id);
  if (value) {
    putSecret(channel.workspaceId, ref, value, by);
    stored.secretRef = ref;
  } else if (stored.secretRef) {
    removeSecret(channel.workspaceId, stored.secretRef);
    delete stored.secretRef;
  }
  delete channel.secret;
}

/** Store a Slack webhook URL while retaining only its non-secret origin. */
export function setChannelTargetSecret(channel: AlertChannel, value: string, by: string): void {
  const stored = channel as StoredAlertChannel;
  assertCanonicalCredentialRefs(channel);
  const ref = alertChannelTargetSecretRef(channel.id);
  const parsed = new URL(value);
  putSecret(channel.workspaceId, ref, value, by);
  stored.targetSecretRef = ref;
  // Keep only a deliberately non-sensitive display value in the channel row.
  // Generic webhook paths may themselves contain bearer material, so the
  // display path is never copied from the submitted URL. Slack keeps its
  // historical origin-only display contract.
  channel.target = channel.kind === "slack"
    ? parsed.origin
    : `${parsed.origin}${parsed.pathname !== "/" || parsed.search ? "/…" : ""}`;
}

/** Remove both independent channel credentials, including old legacy fields. */
export function removeChannelSecrets(channel: AlertChannel): void {
  const before = snapshotChannelCredentials(channel);
  const stored = channel as StoredAlertChannel;
  try {
    const refs = new Set<string>();
    if (stored.secretRef) refs.add(stored.secretRef);
    if (stored.targetSecretRef) refs.add(stored.targetSecretRef);
    for (const ref of refs) removeSecret(channel.workspaceId, ref);
    delete stored.secretRef;
    delete stored.targetSecretRef;
    delete channel.secret;
  } catch (error) {
    try {
      restoreChannelCredentials(channel, before);
    } catch {
      throw new Error("The alert credentials could not be deleted or rolled back safely; inspect the secret store before retrying.");
    }
    throw error;
  }
}

/** Safely migrate legacy plaintext channel keys when encryption is configured. */
function migrateLegacyChannelSecrets(channels: AlertChannel[]): boolean {
  // Metadata/settings pages may still load legacy rows without the key, but
  // channelSecret/channelTarget refuse to use them. This preserves a safe,
  // redacted admin view while keeping delivery fail-closed until migration is
  // possible; it must not turn an unavailable key into a 500 for every page.
  if (!secretStoreState().configured) return false;
  let changed = false;
  for (const channel of channels) {
    const stored = channel as StoredAlertChannel;
    let before: ChannelCredentialSnapshot | undefined;
    try {
      before = snapshotChannelCredentials(channel);
      // The previous slice used SIGNING_SECRET for Slack's target. Move it to
      // its distinct reference before handling new legacy rows.
      if (channel.kind === "slack" && stored.secretRef && !stored.targetSecretRef) {
        const value = readSecretValue(channel.workspaceId, stored.secretRef);
        if (value === undefined)
          throw new Error("The Slack webhook credential cannot be migrated because its encrypted value is missing or unreadable.");
        setChannelTargetSecret(channel, value, "system:alert-channel-migration");
        removeSecret(channel.workspaceId, stored.secretRef);
        delete stored.secretRef;
        changed = true;
      }
      if (channel.kind !== "email" && !stored.targetSecretRef) {
        setChannelTargetSecret(channel, channel.target, "system:alert-channel-migration");
        changed = true;
      }
      if (channel.kind === "webhook" && channel.secret !== undefined) {
        setChannelSecret(channel, channel.secret, "system:alert-channel-migration");
        changed = true;
      }
    } catch (error) {
      // A missing/tampered old reference must not turn a metadata/settings
      // read into a 500. No mutation has happened when the snapshot itself
      // fails; leave the row untouched and let delivery fail closed when it
      // tries to resolve the unavailable credential.
      if (!before) continue;
      try {
        restoreChannelCredentials(channel, before);
        // Persist the rollback before surfacing the error. This prevents a
        // secret write that failed after metadata mutation from being left in
        // memory for a later request to flush accidentally.
        save();
        flush();
      } catch {
        throw new Error("An alert channel migration failed and could not be rolled back safely; inspect the secret store before retrying.");
      }
      throw new Error(
        `An alert channel credential could not be migrated safely. No plaintext fallback is permitted: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (changed) flush();
  }
  return changed;
}

/** The one sentence an operator sees for a row this store cannot migrate. */
export const POSTGRES_MIGRATION_BLOCKED =
  "blocked: Postgres legacy row requires the coordinated migration (see runbook)";

export type AlertSecretMigrationStatus = "candidate" | "migrated" | "unchanged" | "blocked";

/** One channel's place in a migration, named so a report can be read row by row. */
export interface AlertSecretMigrationEntry {
  channelId: string;
  name: string;
  kind: AlertChannelKind;
  status: AlertSecretMigrationStatus;
  /** What is still plaintext, or why the row cannot be moved. */
  detail?: string;
}

export interface AlertSecretMigrationReport {
  inspected: number;
  migrated: number;
  unchanged: number;
  blocked: number;
  channels: AlertSecretMigrationEntry[];
}

/** What is still in the clear on this row, or undefined when nothing is. */
function legacyCredential(channel: AlertChannel): string | undefined {
  const stored = channel as StoredAlertChannel;
  if (channel.kind === "email") return undefined;
  const parts: string[] = [];
  if (!stored.targetSecretRef)
    parts.push(channel.kind === "slack" && stored.secretRef ? "Slack URL under the old reference" : "plaintext target URL");
  if (channel.kind === "webhook" && channel.secret !== undefined) parts.push("plaintext signing secret");
  return parts.length ? parts.join(" and ") : undefined;
}

/**
 * What a migration would do, without doing any of it.
 *
 * This is what makes the PostgreSQL hold *operable* rather than merely safe:
 * `migrateLegacyChannelSecretsAsync` still refuses that store outright (the
 * secret row and the channel row have no shared transaction — ADR D-4), but an
 * operator can now see exactly which channels are held, by name, and what each
 * one is still holding in the clear. The runbook step is in
 * docs/hosted/PROVIDERS.md → "Alert channel secrets".
 */
export function planAlertSecretMigration(channels: AlertChannel[]): AlertSecretMigrationEntry[] {
  const blocked = isPostgres();
  return channels.map((channel) => {
    const detail = legacyCredential(channel);
    return {
      channelId: channel.id,
      name: channel.name,
      kind: channel.kind,
      status: !detail ? "unchanged" : blocked ? "blocked" : "candidate",
      detail: detail ? (blocked ? `${POSTGRES_MIGRATION_BLOCKED} — ${detail}` : detail) : undefined,
    };
  });
}

type PendingAlertSecretMigration = {
  channelId: string;
  workspaceId: string;
  startedAt: string;
};

type AlertMigrationSettings = {
  pendingAlertSecretMigrations?: PendingAlertSecretMigration[];
};

function pendingAlertSecretMigrations(): PendingAlertSecretMigration[] {
  const settings = db().settings as AlertMigrationSettings;
  settings.pendingAlertSecretMigrations ??= [];
  return settings.pendingAlertSecretMigrations;
}

async function beginAlertSecretMigration(channel: AlertChannel): Promise<void> {
  const pending = pendingAlertSecretMigrations();
  if (!pending.some((entry) => entry.channelId === channel.id && entry.workspaceId === channel.workspaceId)) {
    pending.push({ channelId: channel.id, workspaceId: channel.workspaceId, startedAt: new Date().toISOString() });
    save();
    await flushPendingAsync();
  }
}

async function finishAlertSecretMigration(channel: AlertChannel): Promise<void> {
  const settings = db().settings as AlertMigrationSettings;
  settings.pendingAlertSecretMigrations = pendingAlertSecretMigrations().filter(
    (entry) => entry.channelId !== channel.id || entry.workspaceId !== channel.workspaceId
  );
  save();
  await flushPendingAsync();
}

/**
 * Clear journal entries whose channel metadata already committed. Entries that
 * still have legacy fields are deliberately retained: the next explicit
 * migration run can retry them without guessing whether the secret write or
 * the settings write was the last durable step.
 */
export async function reconcilePendingAlertSecretMigrationsAsync(): Promise<number> {
  const settings = db().settings as AlertMigrationSettings;
  const pending = settings.pendingAlertSecretMigrations ?? [];
  if (pending.length === 0) return 0;
  const channels = ((settings as { alertChannels?: AlertChannel[] }).alertChannels ?? []);
  const retained = pending.filter((entry) => {
    const channel = channels.find((candidate) => candidate.id === entry.channelId && candidate.workspaceId === entry.workspaceId);
    if (!channel) return false;
    const stored = channel as StoredAlertChannel;
    return Boolean(channel.secret !== undefined || !stored.targetSecretRef ||
      (channel.kind === "webhook" && !stored.secretRef));
  });
  const cleared = pending.length - retained.length;
  if (cleared) {
    settings.pendingAlertSecretMigrations = retained;
    save();
    await flushPendingAsync();
  }
  return cleared;
}

/**
 * Explicit, awaitable migration for an operator rehearsal or cutover.
 * Metadata reads never call this implicitly on a Postgres-backed process:
 * callers must opt in, keep the key available, and flush the store after the
 * returned mutations have been reviewed.
 */
export async function migrateLegacyChannelSecretsAsync(
  channels: AlertChannel[]
): Promise<AlertSecretMigrationReport> {
  if (!secretStoreState().configured)
    throw new Error(
      "Alert secret migration is blocked: configure ZENITH_SECRET_KEY before attempting an apply."
    );
  if (isPostgres())
    throw new Error(
      "Alert secret migration is blocked for Postgres until the secret row and channel metadata can be committed in one coordinated transaction. Use the reviewed SQL/operator migration path."
    );
  await reconcilePendingAlertSecretMigrationsAsync();
  let migrated = 0;
  const entries: AlertSecretMigrationEntry[] = [];
  for (const channel of channels) {
    const legacy = legacyCredential(channel);
    const stored = channel as StoredAlertChannel;
    const candidate = channel.kind !== "email" &&
      (!stored.targetSecretRef || (channel.kind === "webhook" && channel.secret !== undefined) ||
        (channel.kind === "slack" && stored.secretRef && !stored.targetSecretRef));
    if (candidate) await beginAlertSecretMigration(channel);
    const before = await snapshotChannelCredentialsAsync(channel);
    let changed = false;
    try {
      if (channel.kind === "slack" && stored.secretRef && !stored.targetSecretRef) {
        const value = await readSecretValueAsync(channel.workspaceId, stored.secretRef);
        if (value === undefined)
          throw new Error("The Slack webhook credential cannot be migrated because its encrypted value is missing or unreadable.");
        await setChannelTargetSecretAsync(channel, value, "system:alert-channel-migration");
        await removeSecretAsync(channel.workspaceId, stored.secretRef);
        delete stored.secretRef;
        changed = true;
      }
      if (channel.kind !== "email" && !stored.targetSecretRef) {
        await setChannelTargetSecretAsync(channel, channel.target, "system:alert-channel-migration");
        changed = true;
      }
      if (channel.kind === "webhook" && channel.secret !== undefined) {
        await setChannelSecretAsync(channel, channel.secret, "system:alert-channel-migration");
        changed = true;
      }
    } catch (error) {
      try {
        await restoreChannelCredentialsAsync(channel, before);
        save();
        await flushPendingAsync();
      } catch {
        throw new Error(
          "Alert secret migration failed and could not be rolled back safely; stop and inspect the secret store."
        );
      }
      throw new Error(
        `Alert secret migration failed for ${channel.id}; no plaintext fallback is permitted: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (changed) {
      // Commit each channel immediately. The secret backend and settings
      // snapshot are separate stores, so a batch-wide final save would leave
      // earlier ciphertext orphaned if a later channel fails. Per-channel
      // commit plus idempotent retry is the narrowest safe boundary here.
      save();
      await flushPendingAsync();
      await finishAlertSecretMigration(channel);
      migrated += 1;
      entries.push({ channelId: channel.id, name: channel.name, kind: channel.kind, status: "migrated", detail: legacy });
    } else {
      if (candidate) await finishAlertSecretMigration(channel);
      entries.push({ channelId: channel.id, name: channel.name, kind: channel.kind, status: "unchanged" });
    }
  }
  return {
    inspected: channels.length,
    migrated,
    unchanged: channels.length - migrated,
    blocked: 0,
    channels: entries,
  };
}

/**
 * The channel list, backfilled in place. Same trick as `tables()` in ./index:
 * a snapshot written before channels existed has no array, and the next save()
 * persists the one we put there.
 */
export function channelTable(): AlertChannel[] {
  const settings = db().settings as { alertChannels?: AlertChannel[] };
  settings.alertChannels ??= [];
  // Postgres-backed request paths must not run the legacy migration through
  // the synchronous compatibility accessors. Delivery performs the same
  // migration with the async secret API when it actually needs the value.
  if (!isPostgres() && migrateLegacyChannelSecrets(settings.alertChannels)) flush();
  return settings.alertChannels;
}

export const channelsOf = (workspaceId: string): AlertChannel[] =>
  channelTable()
    .filter((c) => c.workspaceId === workspaceId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

export const findChannel = (channelId: string): AlertChannel | undefined =>
  channelTable().find((c) => c.id === channelId);

export const requireChannel = (channelId: string): AlertChannel => {
  const channel = findChannel(channelId);
  if (!channel)
    throw new Error(
      `Delivery channel "${channelId}" was not found. Reload Settings → Alerts — someone may have deleted it.`
    );
  return channel;
};

/** The workspace a rule's alerts belong to, via its project. */
export const workspaceOfRule = (rule: Pick<AlertRule, "projectId">): string | undefined =>
  q.project(rule.projectId)?.workspaceId;

/**
 * Which channels this rule delivers to, right now.
 *
 * `channelIds` unset = every enabled channel in the workspace. `[]` = none, so
 * a rule can be kept deliberately on-screen-only. A disabled channel is never
 * used, whether it was named or not.
 */
export function channelsForRule(rule: AlertRule, workspaceId?: string): AlertChannel[] {
  const ws = workspaceId ?? workspaceOfRule(rule);
  if (!ws) return [];
  const enabled = channelsOf(ws).filter((c) => c.enabled);
  if (rule.channelIds === undefined) return enabled;
  return enabled.filter((c) => rule.channelIds!.includes(c.id));
}

/* --------------------------------- masking -------------------------------- */

/**
 * A target safe to put in a response.
 *
 * A Slack incoming-webhook URL is a bearer credential in URL form, and a
 * generic webhook URL often carries a token in its path or query too — so
 * everything past the host is replaced. An email address is not a credential
 * (the SMTP password lives in `ZENITH_SMTP_URL`, never on the channel), so it
 * is shown: masking it would only stop an operator checking the recipient.
 */
export function maskTarget(kind: AlertChannelKind, target: string): string {
  if (kind === "email") return target;
  try {
    const url = new URL(target);
    const rest = url.pathname === "/" && !url.search ? "" : "/…";
    return `${url.protocol}//${url.host}${rest}`;
  } catch {
    // Not a URL — it should not have been stored, but never echo it back.
    return "(not a valid URL)";
  }
}

/** A channel as it goes on the wire: no secret, no token in the target. */
export interface PublicAlertChannel
  extends Omit<AlertChannel, "secret" | "target" | "secretRef" | "targetSecretRef"> {
  /** the endpoint with anything credential-shaped removed */
  target: string;
  /** whether the channel's credential is set — never the credential itself */
  hasSecret: boolean;
}

export const publicChannel = (c: AlertChannel): PublicAlertChannel => ({
  id: c.id,
  workspaceId: c.workspaceId,
  kind: c.kind,
  name: c.name,
  target: maskTarget(c.kind, c.target),
  hasSecret: channelHasSecret(c),
  enabled: c.enabled,
  createdBy: c.createdBy,
  createdAt: c.createdAt,
  lastDelivery: c.lastDelivery,
});

export const publicChannels = (workspaceId: string): PublicAlertChannel[] =>
  channelsOf(workspaceId).map(publicChannel);
