/**
 * The alerts package's Postgres contract — the half of the store that cannot be
 * proved against a file.
 *
 * `store-contract.test.ts` asks "does every implementation behave the same?".
 * This file asks the questions that only have a Postgres answer, and it asks
 * them of a **real** project: that the unique index the domain claims actually
 * exists, and that two instances draining one outbox produce exactly one send.
 * A fake client would answer both by agreeing with the code under test, so
 * there is no fake here.
 *
 * It therefore runs only under `ZENITH_CONTRACT_POSTGRES=1` with the Supabase
 * URL and service-role key exported — the same three conditions
 * `./factories.ts` states — and skips whole and silent otherwise, which is what
 * CI, a fresh clone and a plain `npx vitest run` get. Every row it writes is
 * filed under `CONTRACT_PREFIX` ids and deleted in `afterAll`, so "delete the
 * test data" means something narrower than "delete the data".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AlertEvent,
  AlertOutboxEntry,
  AlertRule,
  NavigatorRun,
  SecurityFinding,
} from "@/lib/domain/types";
import { tempDataDir } from "../../_support/data-dir";
import { CONTRACT_PREFIX, postgresContractEnabled } from "./factories";

// MUST precede every application import: the file store pins ZENITH_DATA the
// moment it is loaded, and the Postgres store keeps its Phase-3 half there.
tempDataDir("zenith-alerts-contract-");

const live = postgresContractEnabled();

// What `@/lib/db/store` answers with, and what the alerts package therefore
// asks. Set before the first application import, and only when this file is
// actually going to run — a skipped suite must not repoint a developer's store.
if (live) process.env.ZENITH_STORE = "postgres";

/* --------------------------------- fixtures -------------------------------- */

const WS = `${CONTRACT_PREFIX}-ws`;
const USER = `${CONTRACT_PREFIX}-user`;
const PROJ = `${CONTRACT_PREFIX}-proj`;
const ENV = `${CONTRACT_PREFIX}-env`;
const CHANNEL = `${CONTRACT_PREFIX}-channel`;
const ACTOR = { type: "user" as const, id: USER, name: "Contract" };

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 2, 12, 0, 0) + minutes * 60_000).toISOString();

/** Tables this file writes, in reverse foreign-key order — what cleanup drops. */
const TABLES = [
  "alert_outbox",
  "alert_events",
  "alert_rules",
  "navigator_runs",
  "findings",
  "environments",
  "projects",
  "members",
  "workspaces",
  "workspace_versions",
] as const;

const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: `${CONTRACT_PREFIX}-rule`,
  projectId: PROJ,
  environmentId: ENV,
  kind: "health_degraded",
  enabled: true,
  createdBy: ACTOR,
  createdAt: at(0),
  ...over,
});

const event = (over: Partial<AlertEvent> = {}): AlertEvent => ({
  id: `${CONTRACT_PREFIX}-event`,
  ruleId: `${CONTRACT_PREFIX}-rule`,
  projectId: PROJ,
  environmentId: ENV,
  firedAt: at(1),
  summary: "api degraded in sandbox.",
  severity: "medium",
  detail: "Health is generated, not measured.",
  simulated: true,
  ...over,
});

const outboxRow = (over: Partial<AlertOutboxEntry> = {}): AlertOutboxEntry => ({
  id: `${CONTRACT_PREFIX}-outbox`,
  workspaceId: WS,
  channelId: CHANNEL,
  eventId: `${CONTRACT_PREFIX}-event`,
  transition: "fired",
  idempotencyKey: `${CONTRACT_PREFIX}-key`,
  status: "pending",
  attempts: 0,
  createdAt: at(1),
  ...over,
});

/* ----------------------------------- run ----------------------------------- */

describe.skipIf(!live)("alerts on Postgres", () => {
  type Pg = typeof import("@/lib/db/postgres-store");
  type PgAlerts = typeof import("@/lib/db/pg/alerts");
  let pg: Pg;
  let alerts: PgAlerts;
  let client: SupabaseClient;
  let store: Pg["PostgresStore"];

  const caller = { id: USER, email: `${USER}@contract.invalid` };

  /**
   * A snapshot scoped to this run's member, loaded the way `route()` loads one.
   *
   * Note what `loadSnapshot` builds over: `FileStore.db()`, one graph per
   * process. Two snapshots in one process therefore share the *objects* and
   * differ only in their `baseline` — which is exactly the state two serverless
   * instances are in, because the baseline is the version each read the row at
   * and the version is what the claim is guarded on.
   */
  const snapshot = () => pg.loadSnapshot(client, caller);

  /**
   * Re-read into the process snapshot, so `store.db()` and its baseline agree
   * again. Every test starts here: a bare `loadSnapshot` refills the shared
   * graph without replacing the process snapshot's baseline, and a flush
   * against that mismatch would try to re-insert rows that already exist.
   */
  const reload = () => pg.primeProcessSnapshot(caller);

  const remove = async (): Promise<void> => {
    for (const table of TABLES) {
      const column = table === "workspaces" ? "id" : "workspace_id";
      await client.from(table).delete().like(column, `${CONTRACT_PREFIX}%`);
    }
  };

  beforeAll(async () => {
    pg = await import("@/lib/db/postgres-store");
    alerts = await import("@/lib/db/pg/alerts");
    store = pg.PostgresStore;
    client = pg.pgClient();
    await remove();

    // The organisational rows every round-3 prefetch hangs off: without a
    // member there are no workspace ids, without a project there are no project
    // ids, and this suite's tables are keyed by one or the other.
    const now = new Date().toISOString();
    const seed = (extra: Record<string, unknown>) => ({
      workspace_id: WS,
      data: {},
      version: 1,
      updated_at: now,
      ...extra,
    });
    await expectOk(client.from("workspaces").insert(seed({ id: WS, slug: WS, name: "Contract" })));
    await expectOk(
      client.from("members").insert(seed({ id: USER, email: `${USER}@contract.invalid`, role: "owner" }))
    );
    await expectOk(
      client.from("projects").insert(seed({ id: PROJ, slug: PROJ, name: "contract" }))
    );
    await expectOk(
      client.from("environments").insert(seed({ id: ENV, project_id: PROJ, class: "sandbox" }))
    );

    await reload();
  });

  // A test that loaded a comparison snapshot left the shared graph filled from
  // the database and the process snapshot's baseline behind it. One re-read
  // puts the two back in step, so each test starts from the table.
  beforeEach(async () => {
    if (client) await reload();
  });

  afterAll(async () => {
    if (!client) return;
    await remove();
  });

  /* ------------------------------- alert rules ------------------------------ */

  it("refuses a second standing rule for one (environment, kind)", async () => {
    const first = pg.toRow("alertRules", rule(), WS);
    await expectOk(client.from("alert_rules").insert(first));

    // A different row id, the same condition on the same environment. The
    // domain says one standing rule per (environment, kind); this is the
    // database saying it too, which is the only version that holds when two
    // instances create one at the same instant.
    const second = pg.toRow("alertRules", rule({ id: `${CONTRACT_PREFIX}-rule-2` }), WS);
    const { error } = await client.from("alert_rules").insert(second);
    expect(error?.code).toBe("23505");
    expect(String(error?.message)).toContain("alert_rules_environment_kind_key");

    // A different kind on the same environment is a different rule, and fine.
    const other = pg.toRow(
      "alertRules",
      rule({ id: `${CONTRACT_PREFIX}-rule-3`, kind: "deploy_failed" }),
      WS
    );
    await expectOk(client.from("alert_rules").insert(other));

    // And it hydrates back into exactly the object that was stored.
    const snap = await reload();
    const loaded = snap.data.alertRules.find((r) => r.id === rule().id);
    expect(loaded).toEqual(rule());
  });

  /* ------------------------------ alert events ------------------------------ */

  it("round-trips an event through open and resolved", async () => {
    store.db().alertEvents.push(event());
    store.save(PROJ);
    await store.flushAsync();

    const opened = await reload();
    expect(opened.data.alertEvents.find((e) => e.id === event().id)).toEqual(event());
    // `resolved_at` is promoted so the open-event index can find it; an open
    // event must read as absent, never as `resolvedAt: null`.
    const row = await one(client, "alert_events", event().id);
    expect(row.resolved_at).toBeNull();
    expect(row.fired_at).not.toBeNull();
    expect(row.rule_id).toBe(`${CONTRACT_PREFIX}-rule`);
    expect(row.data).not.toHaveProperty("firedAt");

    const resolved = event({ resolvedAt: at(9), resolvedReason: "Recovered." });
    const held = store.db().alertEvents.find((e) => e.id === event().id)!;
    held.resolvedAt = resolved.resolvedAt;
    held.resolvedReason = resolved.resolvedReason;
    store.save(PROJ);
    await store.flushAsync();

    const closed = await reload();
    expect(closed.data.alertEvents.find((e) => e.id === event().id)).toEqual(resolved);
    expect((await one(client, "alert_events", event().id)).resolved_at).not.toBeNull();
  });

  /* --------------------------------- outbox --------------------------------- */

  it("lets exactly one of two snapshots claim a pending row", async () => {
    await expectOk(client.from("alert_outbox").insert(pg.toRow("alertOutbox", outboxRow(), WS)));

    // Two instances, each with its own snapshot of the same row at the same
    // version. This is the race the whole claim protocol exists for.
    const a = await snapshot();
    const b = await snapshot();
    const rowA = a.data.alertOutbox.find((r) => r.id === outboxRow().id)!;
    const rowB = b.data.alertOutbox.find((r) => r.id === outboxRow().id)!;
    expect(rowA).toEqual(outboxRow());
    expect(rowB).toEqual(outboxRow());

    const won = await Promise.all([
      alerts.claimOutboxRowIn(a, rowA, at(2)),
      alerts.claimOutboxRowIn(b, rowB, at(2)),
    ]);
    expect(won.filter(Boolean)).toHaveLength(1);

    // Whichever lost is not left disagreeing with the table: both snapshots
    // now read `sending`, so neither will 409 its next flush.
    expect(rowA.status).toBe("sending");
    expect(rowB.status).toBe("sending");
    expect((await one(client, "alert_outbox", outboxRow().id)).status).toBe("sending");

    // A row already claimed is never claimed again, by anybody.
    expect(await alerts.claimOutboxRowIn(a, rowA, at(3))).toBe(false);
  });

  it("reclaims a claim older than the lease and leaves a live one alone", async () => {
    const lease = 120_000;
    const snap = await reload();
    const row = snap.data.alertOutbox.find((r) => r.id === outboxRow().id)!;
    expect(row.status).toBe("sending"); // left claimed by the test above

    // `claimedAt` is the previous test's `at(2)`, which is months in the past
    // relative to a `now` of its own moment — so pin `now` instead of the
    // clock, the same way the file-store suite does.
    const claimed = Date.parse(row.claimedAt!);
    expect(await alerts.reclaimStaleIn(snap, lease, claimed + 1_000)).toBe(0);
    expect(row.status).toBe("sending");

    expect(await alerts.reclaimStaleIn(snap, lease, claimed + lease + 1_000)).toBe(1);
    expect(row.status).toBe("pending");
    expect(row.claimedAt).toBeUndefined();
    const stored = await one(client, "alert_outbox", outboxRow().id);
    expect(stored.status).toBe("pending");
    expect(stored.claimed_at).toBeNull();
    expect(stored.idempotency_key).toBe(`${CONTRACT_PREFIX}-key`);

    // And it is claimable again, under the key the receiver already saw.
    expect(await alerts.claimOutboxRowIn(snap, row, at(20))).toBe(true);
  });

  it("refuses a second outbox row for one idempotency key", async () => {
    const duplicate = pg.toRow(
      "alertOutbox",
      outboxRow({ id: `${CONTRACT_PREFIX}-outbox-2` }),
      WS
    );
    const { error } = await client.from("alert_outbox").insert(duplicate);
    expect(error?.code).toBe("23505");
    expect(String(error?.message)).toContain("alert_outbox_idempotency_key");
  });

  /* -------------------------- findings & navigator -------------------------- */

  it("round-trips a security finding", async () => {
    const finding: SecurityFinding = {
      id: `${CONTRACT_PREFIX}-finding`,
      projectId: PROJ,
      environmentId: ENV,
      severity: "high",
      title: "Service is reachable from the public internet",
      detail: "The route has no authentication in front of it.",
      status: "open",
      createdAt: at(3),
    };
    store.db().findings.push(finding);
    store.save(PROJ);
    await store.flushAsync();

    const snap = await reload();
    expect(snap.data.findings.find((f) => f.id === finding.id)).toEqual(finding);
    const row = await one(client, "findings", finding.id);
    expect(row.severity).toBe("high");
    expect(row.status).toBe("open");
    expect(row.environment_id).toBe(ENV);
    expect(row.workspace_id).toBe(WS); // carried through the project, not the object
    expect(row.data).not.toHaveProperty("projectId");
  });

  it("round-trips a Navigator run", async () => {
    const run: NavigatorRun = {
      id: `${CONTRACT_PREFIX}-run`,
      projectId: PROJ,
      goal: "Deploy the newest revision to sandbox",
      status: "awaiting_approval",
      steps: [
        {
          id: "s1",
          seq: 0,
          title: "Deploy r1 to sandbox",
          rationale: "It is the newest revision.",
          actionId: "deploy.create",
          input: { environmentId: ENV },
          risk: "medium",
          needsApproval: true,
          status: "proposed",
        },
      ],
      createdAt: at(4),
    };
    store.db().navigatorRuns.push(run);
    store.save(PROJ);
    await store.flushAsync();

    const snap = await reload();
    expect(snap.data.navigatorRuns.find((r) => r.id === run.id)).toEqual(run);
    const row = await one(client, "navigator_runs", run.id);
    expect(row.status).toBe("awaiting_approval");
    expect(row.project_id).toBe(PROJ);
    // Steps are not a promoted column, so they live in `data` intact.
    expect((row.data as { steps: unknown[] }).steps).toHaveLength(1);
  });
});

/* --------------------------------- helpers --------------------------------- */

type Result = { error: { message: string } | null };

/** Fail with the database's own sentence rather than a bare `expect` diff. */
async function expectOk(promise: PromiseLike<Result>): Promise<void> {
  const { error } = await promise;
  if (error) throw new Error(error.message);
}

/** One row by id, as the table actually holds it. */
async function one(
  client: SupabaseClient,
  table: string,
  id: string
): Promise<Record<string, unknown>> {
  const { data, error } = await client.from(table).select("*").eq("id", id).limit(1);
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0];
  if (!row) throw new Error(`No row ${id} in ${table}`);
  return row as Record<string, unknown>;
}
