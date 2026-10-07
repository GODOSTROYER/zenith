/**
 * Reading and writing the committed workflow-history fixtures
 * (tests/fixtures/workflow-histories). Shared by the recorder
 * (history-record.test.ts), the replay gate (history-replay.test.ts) and the
 * upgrade rehearsal. Test support only; never imported by product code.
 *
 * File format (zenith.workflow-history.v1): the Temporal history in the SDK's
 * JSON form (`historyToJSON`) plus the identity needed to replay it. MANIFEST.json
 * records a sha256 per fixture so a fixture cannot be edited or regenerated
 * silently: the replay gate refuses a mismatch, and the recorder never overwrites
 * an existing fixture unless ZENITH_RECORD_OVERWRITE=1 (a deliberate, reviewed act:
 * overwriting a frozen history discards the evidence it exists to keep).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { History } from "@temporalio/common/lib/proto-utils";
import { historyFromJSON, historyToJSON } from "@temporalio/common/lib/proto-utils";

export const FIXTURE_FORMAT = "zenith.workflow-history.v1";
export const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/workflow-histories");
export const MANIFEST_FILE = "MANIFEST.json";

export interface HistoryFixture {
  format: typeof FIXTURE_FORMAT;
  scenario: string;
  workflowType: string;
  covers: string;
  workflowId: string;
  /** the SDK version that recorded it, for diagnosis only */
  temporalSdk: string;
  history: unknown;
}

export interface FixtureManifest {
  format: "zenith.workflow-history-manifest.v1";
  /** file name -> sha256 of the file's exact bytes */
  fixtures: Record<string, string>;
}

export const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function fixtureFiles(dir: string = FIXTURE_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json") && f !== MANIFEST_FILE).sort();
}

export function readFixture(file: string, dir: string = FIXTURE_DIR): HistoryFixture {
  const parsed = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as HistoryFixture;
  if (parsed.format !== FIXTURE_FORMAT) throw new Error(`${file} is not a ${FIXTURE_FORMAT} fixture`);
  return parsed;
}

export function readManifest(dir: string = FIXTURE_DIR): FixtureManifest | undefined {
  const file = path.join(dir, MANIFEST_FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as FixtureManifest) : undefined;
}

export const historyOf = (fixture: HistoryFixture): History => historyFromJSON(fixture.history);

/** Serialise one recorded history. Pure; the file name is `<scenario>.json`. */
export function serializeFixture(input: { scenario: string; workflowType: string; covers: string; workflowId: string; temporalSdk: string; history: History }): string {
  const fixture: HistoryFixture = {
    format: FIXTURE_FORMAT,
    scenario: input.scenario,
    workflowType: input.workflowType,
    covers: input.covers,
    workflowId: input.workflowId,
    temporalSdk: input.temporalSdk,
    history: JSON.parse(historyToJSON(input.history)),
  };
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/** Write a fixture and merge its hash into the manifest. Refuses to overwrite unless `overwrite`. Returns false when skipped. */
export function writeFixture(file: string, content: string, opts: { overwrite: boolean; dir?: string }): boolean {
  const dir = opts.dir ?? FIXTURE_DIR;
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  if (existsSync(target) && !opts.overwrite) return false;
  writeFileSync(target, content, "utf8");
  const manifest: FixtureManifest = readManifest(dir) ?? { format: "zenith.workflow-history-manifest.v1", fixtures: {} };
  manifest.fixtures[file] = sha256(content);
  const sorted = Object.fromEntries(Object.entries(manifest.fixtures).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify({ ...manifest, fixtures: sorted }, null, 2)}\n`, "utf8");
  return true;
}

/** Every string anywhere in `value`, including base64 payload bodies decoded to text. Used to find patch markers. */
export function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    if (/^[A-Za-z0-9+/]{8,}={0,2}$/.test(value)) {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      if (/^[\x20-\x7e]+$/.test(decoded)) out.push(decoded);
    }
  } else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

/** The patch ids recorded as markers in a history. */
export function patchMarkersIn(fixture: HistoryFixture): Set<string> {
  const events = ((fixture.history as { events?: Array<Record<string, unknown>> }).events ?? []).filter((e) => e.markerRecordedEventAttributes);
  const found = new Set<string>();
  for (const event of events) for (const s of stringsIn(event.markerRecordedEventAttributes)) found.add(s.replace(/^"|"$/g, ""));
  return found;
}
