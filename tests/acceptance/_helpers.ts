/** Test helpers. AWS handles here always use fake credentials and SDK mocks;
 * evidence provenance is local/simulated, never live cloud success. */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { loadLiveConfig } from "../../scripts/acceptance/config";
import { EvidenceRecorder, type Provenance } from "../../scripts/acceptance/evidence";
import { createHttpProbe } from "../../scripts/acceptance/http-probe";
import type { AwsAccess, ScenarioContext, ScenarioDefinition } from "../../scripts/acceptance/types";

export const RUN = "zlive-202609301200-ab12";
export const ACCOUNT = "123456789012";
export const REGION = "us-east-1";
export const config = () => ({ ...loadLiveConfig({}), awsAccountId: ACCOUNT, region: REGION });
export const access = (): AwsAccess => ({ kind: "ambient", accountId: ACCOUNT, region: REGION,
  client: (ctor, over) => new ctor({ region: over?.region ?? REGION, credentials: { accessKeyId: "test", secretAccessKey: "test" } }),
  childProcessEnv: async () => ({}) });
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
export async function temp(): Promise<string> { const d = await mkdtemp(path.join(os.tmpdir(), "zenith-acceptance-test-")); dirs.push(d); return d; }
export async function context(provenance: Provenance = "local"): Promise<ScenarioContext> {
  const dir = await temp();
  const evidence = new EvidenceRecorder({ runId: RUN, scenarios: ["J"], provenance, outDir: dir }); await evidence.init();
  return { runId: RUN, config: config(), evidence, probe: createHttpProbe(), state: new Map(), signal: new AbortController().signal,
    sleep: async () => undefined, now: () => new Date(), log: () => undefined, scratchDir: dir, runStateFile: path.join(evidence.dir, "run-state.json") };
}
export function definition(over: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return { id: "J", title: "test", summary: "test", needs: { cloud: "none", controlPlane: false, temporal: false }, mutates: false, createsResources: false,
    dependsOn: [], prerequisites: [], steps: [], passCriteria: [{ id: "checked", text: "observed condition" }], proves: ["test"], cannotProve: ["cloud"], blockedOn: [], runsLocally: true, costNote: "free", ...over };
}
