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
import { createRequire } from "node:module";
import type { History } from "@temporalio/common/lib/proto-utils";
import type * as Proto from "@temporalio/proto";

// SDK 1.24.0 resolves its converter and schema through separate protobufjs 8.8.0
// copies in our lockfile. The public full ProtoJSON converter must share the
// reflected schema's Type constructor; no protobuf fields are encoded here.
const localRequire = createRequire(import.meta.url);
const protoRequire = createRequire(localRequire.resolve("@temporalio/proto"));
const proto = localRequire("@temporalio/proto") as typeof Proto & { lookupType(name: string): unknown };
const historyType = proto.lookupType("temporal.api.history.v1.History");
const protoJson = protoRequire("protobufjs/ext/protojson") as {
  toJson(type: unknown, history: History): unknown;
  fromJson(type: unknown, json: unknown, options: { ignoreUnknownFields: boolean }): History | null;
};

/* Legacy enum normalization below is retained from @temporalio/common 1.24.0,
 * src/proto-utils.ts (historyFromJSON), with its original parse policy.
 * The MIT License
 * Copyright (c) 2021-2025 Temporal Technologies Inc. All rights reserved.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
function historyFromJSON(history: unknown): History {
  function pascalCaseToConstantCase(s: string) {
    return s.replace(/[^\b][A-Z]/g, (m) => `${m[0]}_${m[1]}`).toUpperCase();
  }
  // Preserve the SDK's compatibility transformation rather than a partial codec.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function fixEnumValue<O extends Record<string, any>>(obj: O, attr: keyof O, prefix: string) {
    return obj[attr] && { [attr]: obj[attr].startsWith(prefix) ? obj[attr] : `${prefix}_${pascalCaseToConstantCase(obj[attr])}` };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function fixHistoryEvent(e: Record<string, any>) {
    const type = Object.keys(e).find((k) => k.endsWith("EventAttributes"));
    if (!type) throw new TypeError(`Missing attributes in history event: ${JSON.stringify(e)}`);
    return {
      ...e, ...fixEnumValue(e, "eventType", "EVENT_TYPE"),
      [type]: {
        ...e[type],
        ...(e[type].taskQueue && { taskQueue: { ...e[type].taskQueue, ...fixEnumValue(e[type].taskQueue, "kind", "TASK_QUEUE_KIND") } }),
        ...fixEnumValue(e[type], "parentClosePolicy", "PARENT_CLOSE_POLICY"),
        ...fixEnumValue(e[type], "workflowIdReusePolicy", "WORKFLOW_ID_REUSE_POLICY"),
        ...fixEnumValue(e[type], "initiator", "CONTINUE_AS_NEW_INITIATOR"),
        ...fixEnumValue(e[type], "retryState", "RETRY_STATE"),
        ...(e[type].childWorkflowExecutionFailureInfo && {
          childWorkflowExecutionFailureInfo: { ...e[type].childWorkflowExecutionFailureInfo, ...fixEnumValue(e[type].childWorkflowExecutionFailureInfo, "retryState", "RETRY_STATE") },
        }),
      },
    };
  }
  if (typeof history !== "object" || history == null || !Array.isArray((history as { events?: unknown }).events)) {
    throw new TypeError("Invalid history, expected an object with an array of events");
  }
  const loaded = protoJson.fromJson(historyType, { events: (history as { events: Array<Record<string, unknown>> }).events.map(fixHistoryEvent) }, { ignoreUnknownFields: true });
  if (loaded === null) throw new TypeError("Invalid history");
  return loaded;
}

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
    history: protoJson.toJson(historyType, proto.temporal.api.history.v1.History.fromObject(input.history)),
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
  const events = (fixture.history as { events?: Array<{ eventType?: unknown; markerRecordedEventAttributes?: { markerName?: unknown; details?: Record<string, { payloads?: Array<{ metadata?: Record<string, unknown>; data?: unknown }> }> } }> }).events ?? [];
  const found = new Set<string>();
  function decode(bytes: unknown): Buffer {
    if (typeof bytes !== "string") throw new Error("Patch marker bytes must be canonical base64.");
    const decoded = Buffer.from(bytes, "base64");
    if (decoded.toString("base64") !== bytes) throw new Error("Patch marker bytes must be canonical base64.");
    return decoded;
  }
  // Pinned Core 1.24.0: constants.rs core_patch; mod.rs patch-data and json/plain
  // encode PatchedMarkerData { id, deprecated }. Do not infer markers from strings.
  for (const event of events) {
    const marker = event.markerRecordedEventAttributes;
    if (event.eventType !== "EVENT_TYPE_MARKER_RECORDED" || marker?.markerName !== "core_patch") continue;
    const detailKeys = Object.keys(marker.details ?? {});
    if (detailKeys.length !== 1 || detailKeys[0] !== "patch-data") throw new Error("Patch marker details must contain exactly patch-data.");
    const payloads = marker.details?.["patch-data"]?.payloads;
    if (!Array.isArray(payloads) || payloads.length !== 1) throw new Error("Patch marker must contain exactly one payload.");
    const payload = payloads[0];
    const metadataKeys = Object.keys(payload?.metadata ?? {});
    if (!payload || metadataKeys.length !== 1 || metadataKeys[0] !== "encoding" || decode(payload.metadata?.encoding).toString("utf8") !== "json/plain") {
      throw new Error("Patch marker payload encoding must be json/plain.");
    }
    const bytes = decode(payload.data);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Patch marker data must be valid UTF-8.");
    const patch = JSON.parse(text) as { id?: unknown; deprecated?: unknown };
    if (!patch || Array.isArray(patch) || Object.keys(patch).length !== 2 || typeof patch.id !== "string" || !patch.id || typeof patch.deprecated !== "boolean") {
      throw new Error("Patch marker data must contain exactly an id and deprecated flag.");
    }
    found.add(patch.id);
  }
  return found;
}
