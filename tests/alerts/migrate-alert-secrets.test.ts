/**
 * The alert-secret migration: the operator's half of SEC-02.
 *
 * Three things are asserted here that nothing else covers.
 *
 *  1. **The PostgreSQL hold is operable, not silent.** The guard stays — the
 *     secret row and the channel row have no shared transaction — but a held
 *     install must be able to see *which* channels are held and what each one
 *     still holds in the clear, and the delivery refusal must name the channel
 *     and the way out. Before this, the only documented remedy was a script
 *     that could not run.
 *  2. **The two-authority write's uncompensated outcome.** A secret write that
 *     commits and a settings write that does not leaves an orphaned secret row.
 *     It is safe (nothing can name it, nothing can open it) and it is
 *     reconciled by re-running, because both writers use a reference derived
 *     from the channel id. That is asserted rather than asserted-in-a-comment.
 *  3. **The script's exit codes**, in a real process, because a runbook branches
 *     on them.
 *
 * Nothing here reaches the network: the file store and the file secret backend
 * are the only storage involved, and the subprocess runs against a copy of this
 * suite's own data directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AlertChannel } from "@/lib/domain/types";
import * as fixtures from "./_fixtures";

process.env.ZENITH_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-alert-migrate-"));
process.env.ZENITH_SECRET_KEY = crypto.randomBytes(32).toString("base64");
process.env.ZENITH_FAST = "1";

const { db, flush, resetDb, save } = await import("@/lib/db/store");
const {
  POSTGRES_MIGRATION_BLOCKED,
  channelTable,
  deliverToChannel,
  migrateLegacyChannelSecretsAsync,
  planAlertSecretMigration,
  reconcilePendingAlertSecretMigrationsAsync,
  setChannelCredentials,
  WEBHOOK_POLICY,
  WEBHOOK_TRANSPORT,
} = await import("@/lib/alerts");
const { readSecretValue } = await import("@/lib/secrets");

const productionResolver = WEBHOOK_POLICY.resolveAll;
const productionTransport = WEBHOOK_TRANSPORT.request;
const { seedData } = fixtures;

type Stored = AlertChannel & { secretRef?: string; targetSecretRef?: string };

/** Legacy rows placed straight into settings, bypassing `channelTable()`'s migration. */
function legacyChannels(...channels: AlertChannel[]): void {
  resetDb(seedData());
  (db().settings as { alertChannels?: AlertChannel[] }).alertChannels = channels;
  save();
  flush();
}

const legacyWebhook = (id: string) =>
  fixtures.channelData({
    id,
    name: `ops ${id}`,
    kind: "webhook",
    target: "https://alerts.example.test/hooks/legacy-token",
    secret: "legacy-signing",
  });

beforeEach(() => {
  resetDb(seedData());
  WEBHOOK_POLICY.resolveAll = async () => ["93.184.216.34"];
});
afterEach(() => {
  WEBHOOK_POLICY.resolveAll = productionResolver;
  WEBHOOK_TRANSPORT.request = productionTransport;
  vi.doUnmock("@/lib/db/store");
  vi.resetModules();
});

/* ---------------------------------- the plan ------------------------------- */

describe("what a migration would touch", () => {
  it("names each legacy row and what it is still holding in the clear", () => {
    const plan = planAlertSecretMigration([
      legacyWebhook("legacy-both"),
      fixtures.channelData({ id: "legacy-target", kind: "slack", name: "deploys", target: "https://hooks.slack.com/services/T/B/x" }),
      fixtures.channelData({ id: "mail", kind: "email", name: "ops mail", target: "ops@example.test" }),
    ]);

    expect(plan).toEqual([
      {
        channelId: "legacy-both",
        name: "ops legacy-both",
        kind: "webhook",
        status: "candidate",
        detail: "plaintext target URL and plaintext signing secret",
      },
      {
        channelId: "legacy-target",
        name: "deploys",
        kind: "slack",
        status: "candidate",
        detail: "plaintext target URL",
      },
      // Email channels hold a recipient, not a credential, and are never moved.
      { channelId: "mail", name: "ops mail", kind: "email", status: "unchanged", detail: undefined },
    ]);
  });

  it("reports an already-migrated row as unchanged", async () => {
    const channel = legacyWebhook("already");
    await migrateLegacyChannelSecretsAsync([channel]);
    expect(planAlertSecretMigration([channel])[0]).toMatchObject({ status: "unchanged" });
  });
});

/* ------------------------------ the Postgres hold -------------------------- */

describe("a Postgres install that cannot migrate in place", () => {
  /** The same modules, with only the store's answer to `isPostgres()` changed. */
  async function onPostgres() {
    vi.doMock("@/lib/db/store", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/db/store")>()),
      isPostgres: () => true,
    }));
    vi.resetModules();
    return import("@/lib/alerts/channels");
  }

  it("reports every held channel by name instead of refusing without a list", async () => {
    const alerts = await onPostgres();
    const plan = alerts.planAlertSecretMigration([legacyWebhook("held-1"), legacyWebhook("held-2")]);

    expect(plan.map((entry) => entry.status)).toEqual(["blocked", "blocked"]);
    expect(plan.map((entry) => entry.name)).toEqual(["ops held-1", "ops held-2"]);
    for (const entry of plan) expect(entry.detail).toContain(POSTGRES_MIGRATION_BLOCKED);
  });

  it("still refuses to run the in-place migration", async () => {
    const alerts = await onPostgres();
    await expect(alerts.migrateLegacyChannelSecretsAsync([legacyWebhook("held-3")])).rejects.toThrow(
      /coordinated transaction/i
    );
  });

  it("tells the operator which channel to reset, on the delivery path", async () => {
    const alerts = await onPostgres();
    const channel = legacyWebhook("held-4");
    const problem: Error = await alerts
      .channelTargetAsync(channel)
      .then(() => new Error("the legacy row was resolved instead of refused"))
      .catch((err: unknown) => err as Error);

    expect(problem).toBeInstanceOf(alerts.ChannelCredentialError);
    expect(problem.message).toContain("held-4");
    expect(problem.message).toContain("ops held-4");
    expect(problem.message).toMatch(/Settings → Alerts/);
    expect(problem.message).toMatch(/PROVIDERS\.md/);
    // The credential itself is never in the sentence that names the problem.
    expect(problem.message).not.toContain("legacy-token");
    expect(problem.message).not.toContain("legacy-signing");
  });
});

/* ----------------------------- the orphaned secret ------------------------- */

describe("a secret write that commits when the settings write does not", () => {
  it("leaves an orphan that nothing can use, and a re-run overwrites it", async () => {
    // The uncompensated outcome of the two-authority write: the secret store
    // took the value and the channel row that would point at it was never
    // saved. Reproduced by writing the credential for a channel that is not in
    // the table and dropping the object.
    const detached = fixtures.channelData({
      id: "orphan",
      name: "ops orphan",
      target: "https://alerts.example.test/hooks/orphan-token",
    });
    setChannelCredentials(detached, { target: detached.target, signing: "orphan-signing" }, "test");
    const targetRef = "vault:alert-channel/orphan/TARGET_URL";
    const signingRef = "vault:alert-channel/orphan/SIGNING_SECRET";
    expect(readSecretValue("ws1", targetRef)).toBe("https://alerts.example.test/hooks/orphan-token");

    // Nothing references it: the channel table has no such row, so no delivery
    // and no export can reach the value.
    legacyChannels();
    expect(channelTable()).toHaveLength(0);
    expect(JSON.stringify(db().settings)).not.toContain("orphan-signing");

    // The re-run writes the *same* canonical references rather than a second
    // pair, so the orphan is overwritten rather than accumulated — which is
    // what makes the migration idempotent after an interrupted attempt.
    const retried = fixtures.channelData({
      id: "orphan",
      name: "ops orphan",
      target: "https://alerts.example.test/hooks/second-attempt",
      secret: "second-signing",
    });
    const report = await migrateLegacyChannelSecretsAsync([retried]);
    expect(report).toMatchObject({ migrated: 1, blocked: 0 });
    expect((retried as Stored).targetSecretRef).toBe(targetRef);
    expect((retried as Stored).secretRef).toBe(signingRef);
    expect(readSecretValue("ws1", targetRef)).toBe("https://alerts.example.test/hooks/second-attempt");
    expect(readSecretValue("ws1", signingRef)).toBe("second-signing");
  });

  it("keeps an interrupted channel in the journal until it is actually migrated", async () => {
    const channel = legacyWebhook("interrupted");
    legacyChannels(channel);
    // What an interrupted apply leaves behind: the journal entry written before
    // the credential was touched, and a row that still looks unmigrated.
    (db().settings as { pendingAlertSecretMigrations?: unknown[] }).pendingAlertSecretMigrations = [
      { channelId: "interrupted", workspaceId: "ws1", startedAt: fixtures.ago(1) },
    ];

    // Reconciliation is not a sweep: it clears what committed and keeps what
    // did not, so the operator's next run retries exactly that channel.
    expect(await reconcilePendingAlertSecretMigrationsAsync()).toBe(0);
    expect(
      (db().settings as { pendingAlertSecretMigrations?: unknown[] }).pendingAlertSecretMigrations
    ).toHaveLength(1);

    await migrateLegacyChannelSecretsAsync([channel]);
    expect(
      (db().settings as { pendingAlertSecretMigrations?: unknown[] }).pendingAlertSecretMigrations
    ).toHaveLength(0);
    expect((channel as Stored).targetSecretRef).toBeTruthy();
    expect(channel.secret).toBeUndefined();
  });
});

/* --------------------------------- the script ------------------------------ */

describe("the script an operator actually runs", () => {
  const TSX = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

  /** A copy of this suite's data directory, so a subprocess apply is isolated. */
  function dataDirCopy(): string {
    flush();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-alert-script-"));
    fs.cpSync(process.env.ZENITH_DATA!, dir, { recursive: true });
    return dir;
  }

  const run = (dir: string, args: string[]) =>
    spawnSync(process.execPath, [TSX, "scripts/migrate-alert-secrets.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ZENITH_DATA: dir },
    });

  it("rehearses by default, writes nothing, and exits 2", () => {
    legacyChannels(legacyWebhook("script-legacy"));
    const dir = dataDirCopy();

    const rehearsal = run(dir, []);
    expect(rehearsal.status).toBe(2);
    expect(rehearsal.stderr).toContain("No changes made");
    const report = JSON.parse(rehearsal.stdout) as {
      mode: string;
      candidates: number;
      channels: { channelId: string; status: string }[];
    };
    expect(report.mode).toBe("dry-run");
    expect(report.candidates).toBe(1);
    expect(report.channels[0]).toMatchObject({ channelId: "script-legacy", status: "candidate" });
    // A rehearsal is a read: the plaintext is exactly where it was.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as {
      settings: { alertChannels: Stored[] };
    };
    expect(onDisk.settings.alertChannels[0].secret).toBe("legacy-signing");
    expect(onDisk.settings.alertChannels[0].targetSecretRef).toBeUndefined();

    // `--dry-run --apply` stays a rehearsal, and says so by exiting 0.
    const both = run(dir, ["--dry-run", "--apply"]);
    expect(both.status).toBe(0);
    expect(JSON.parse(both.stdout).mode).toBe("dry-run");

    // And the apply moves it.
    const applied = run(dir, ["--apply"]);
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ mode: "apply", migrated: 1, blocked: 0 });
    const after = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as {
      settings: { alertChannels: Stored[] };
    };
    expect(after.settings.alertChannels[0].secret).toBeUndefined();
    expect(after.settings.alertChannels[0].targetSecretRef).toBe(
      "vault:alert-channel/script-legacy/TARGET_URL"
    );
    expect(JSON.stringify(after.settings)).not.toContain("legacy-token");
    expect(JSON.stringify(after.settings)).not.toContain("legacy-signing");
  }, 120_000);
});

/* --------------------------- delivery stays honest ------------------------- */

describe("delivery after a migration", () => {
  it("sends to the real URL and keeps only the origin on the row", async () => {
    const channel = legacyWebhook("post-migration");
    legacyChannels(channel);
    await migrateLegacyChannelSecretsAsync([channel]);

    const calls: string[] = [];
    WEBHOOK_TRANSPORT.request = async (target) => {
      calls.push(target.url.toString());
      return new Response(null, { status: 204 });
    };
    const result = await deliverToChannel(channel, {
      phase: "test",
      title: "Test message from Zenith",
      body: "…",
      severity: "low",
      simulated: false,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["https://alerts.example.test/hooks/legacy-token"]);
    expect(channel.target).toBe("https://alerts.example.test/…");
  });
});
