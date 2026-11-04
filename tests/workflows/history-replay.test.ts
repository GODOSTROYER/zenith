/**
 * PROD-OPS-03 replay gate. Replays every committed recorded workflow history
 * (tests/fixtures/workflow-histories) against the CURRENT workflow bundle and fails
 * on any nondeterminism. No Temporal server is needed: replay runs the workflow
 * code against the recorded events only.
 *
 * The gate also fails (rather than skips) when:
 *  - a registered workflow type has no scenario or no committed fixture (a new
 *    workflow, including the wave-3 ones, cannot ship without recorded history),
 *  - an active patch id has no committed history that carries its marker,
 *  - a fixture is missing from, or differs from, MANIFEST.json (a frozen history
 *    cannot be edited or regenerated silently).
 * Missing fixtures are an instruction, not a pass:
 *   ZENITH_RECORD_WORKFLOW_HISTORIES=1 npx vitest run tests/workflows/history-record.test.ts
 *   (then commit tests/fixtures/workflow-histories).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { REGISTERED_WORKFLOW_TYPES, WORKFLOW_PATCHES } from "@/lib/workflows/versioning";
import { WORKFLOW_HISTORY_SCENARIOS } from "./history-scenarios";
import { FIXTURE_DIR, fixtureFiles, historyOf, patchMarkersIn, readFixture, readManifest, sha256 } from "./history-fixtures";
import { workflowBundlePath } from "./support";

const ROOT = path.resolve(__dirname, "../..");
const RECORD_HINT = "Record them: ZENITH_RECORD_WORKFLOW_HISTORIES=1 npx vitest run tests/workflows/history-record.test.ts, then commit tests/fixtures/workflow-histories.";
const files = fixtureFiles();
const fixtures = files.map((file) => ({ file, fixture: readFixture(file) }));

/** Canonical CI selects this lane after the first current-code corpus was frozen.
 * Missing fixtures fail when selected; recording stays opt-in. These synthetic
 * histories do not claim compatibility with an earlier released version.
 */
const lane = process.env.ZENITH_REPLAY_LANE === "1";
if (!lane) it.skip("replay lane not selected: run npm run replay:check", () => undefined);

let bundle = "";
beforeAll(async () => { if (lane) bundle = await workflowBundlePath(); }, 240_000);

async function replay(fixture: ReturnType<typeof readFixture>, entry?: string): Promise<void> {
  const codePath = entry ? await workflowBundlePath(entry) : bundle;
  await Worker.runReplayHistory({ workflowBundle: { codePath } }, historyOf(fixture), fixture.workflowId);
}

describe.skipIf(!lane)("committed workflow histories: inventory and integrity", () => {
  it("fixtures exist", () => {
    expect(files.length, `no fixtures in ${FIXTURE_DIR}. ${RECORD_HINT}`).toBeGreaterThan(0);
  });

  it("every fixture is listed in MANIFEST.json with an identical hash, and nothing else is listed", () => {
    const manifest = readManifest();
    expect(manifest, `MANIFEST.json missing. ${RECORD_HINT}`).toBeDefined();
    expect(Object.keys(manifest!.fixtures).sort()).toEqual(files);
    for (const file of files) expect(sha256(readFileSync(path.join(FIXTURE_DIR, file))), `${file} differs from MANIFEST.json (frozen histories must not be edited)`).toBe(manifest!.fixtures[file]);
  });

  it("every scenario has exactly its committed fixture, and no fixture is orphaned", () => {
    const scenarioFiles = WORKFLOW_HISTORY_SCENARIOS.map((s) => `${s.id}.json`).sort();
    expect(files, `fixtures and scenarios differ. ${RECORD_HINT}`).toEqual(scenarioFiles);
    expect(new Set(scenarioFiles).size, "scenario ids are unique").toBe(scenarioFiles.length);
  });

  it("every registered workflow type (including wave-3 codingAgentRunWorkflow, teardown review, sweep and maintenance) has a scenario and a fixture", () => {
    for (const type of REGISTERED_WORKFLOW_TYPES) {
      expect(WORKFLOW_HISTORY_SCENARIOS.some((s) => s.workflowType === type), `${type} has no history scenario`).toBe(true);
      expect(fixtures.some(({ fixture }) => fixture.workflowType === type), `${type} has no committed fixture. ${RECORD_HINT}`).toBe(true);
    }
    for (const { file, fixture } of fixtures) expect(REGISTERED_WORKFLOW_TYPES as readonly string[], `${file} names an unregistered workflow type`).toContain(fixture.workflowType);
  });

  it("each fixture's recorded history starts with the workflow type it declares", () => {
    for (const { file, fixture } of fixtures) {
      const events = (fixture.history as { events: Array<{ workflowExecutionStartedEventAttributes?: { workflowType?: { name?: string } } }> }).events;
      expect(events[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name, file).toBe(fixture.workflowType);
    }
  });

  it("every active patch id has at least one committed history that carries its marker", () => {
    for (const patch of WORKFLOW_PATCHES.filter((p) => p.status === "active")) {
      const carriers = fixtures.filter(({ fixture }) => fixture.workflowType === patch.workflow && patchMarkersIn(fixture).has(patch.id));
      expect(carriers.length, `no committed ${patch.workflow} history carries the ${patch.id} marker. ${RECORD_HINT}`).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!lane)("committed workflow histories replay against the current bundle", () => {
  for (const { file, fixture } of fixtures) {
    it(`${file} replays deterministically`, async () => {
      await replay(fixture);
    }, 60_000);
  }
});

describe.skipIf(!lane)("the replay gate has teeth", () => {
  it("a deploy history is rejected by a workflow that schedules its activities in a different order", async () => {
    const deploy = fixtures.find(({ file }) => file === "deploy-happy-build.json");
    expect(deploy, `deploy-happy-build.json missing. ${RECORD_HINT}`).toBeDefined();
    await replay(deploy!.fixture); // fine against the real code
    const reordered = path.join(ROOT, "tests/workflows/fixtures/reordered-deploy.ts");
    await expect(replay(deploy!.fixture, reordered)).rejects.toBeInstanceOf(DeterminismViolationError);
  }, 120_000);

  it("a history with its activity events removed is rejected", async () => {
    const deploy = fixtures.find(({ file }) => file === "deploy-happy-build.json");
    expect(deploy, `deploy-happy-build.json missing. ${RECORD_HINT}`).toBeDefined();
    const history = JSON.parse(JSON.stringify(deploy!.fixture.history)) as { events: Array<Record<string, unknown>> };
    const cut = history.events.findIndex((e) => e.activityTaskScheduledEventAttributes);
    expect(cut).toBeGreaterThan(0);
    // Drop the first scheduled activity (and its start/complete pair) while keeping later events: replay must notice.
    const scheduledId = String((history.events[cut] as { eventId?: unknown }).eventId);
    history.events = history.events.filter((e) => {
      const a = e.activityTaskScheduledEventAttributes ? String(e.eventId) : undefined;
      const started = (e.activityTaskStartedEventAttributes as { scheduledEventId?: unknown } | undefined)?.scheduledEventId;
      const completed = (e.activityTaskCompletedEventAttributes as { scheduledEventId?: unknown } | undefined)?.scheduledEventId;
      return a !== scheduledId && String(started) !== scheduledId && String(completed) !== scheduledId;
    });
    await expect(replay({ ...deploy!.fixture, history })).rejects.toThrow();
  }, 120_000);
});
