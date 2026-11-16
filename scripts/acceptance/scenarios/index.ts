/** Stable A–J catalogue. Selection is ordered, explicit and rejects typos. */
import { UsageError } from "../args";
import { SCENARIO_IDS, type ScenarioDefinition, type ScenarioId } from "../types";
import { demoA } from "./a-autonomous-deploy";
import { demoB } from "./b-incident-diagnosis";
import { demoC } from "./c-approved-remediation";
import { demoD } from "./d-drift";
import { demoE } from "./e-restart-recovery";
import { demoF } from "./f-credential-revocation";
import { demoG } from "./g-kubernetes-deploy";
import { demoH } from "./h-mcp";
import { demoI } from "./i-managed-provider";
import { demoJ } from "./j-multicloud-planning";

export const SCENARIOS: Record<ScenarioId, ScenarioDefinition> = { A: demoA, B: demoB, C: demoC, D: demoD, E: demoE, F: demoF, G: demoG, H: demoH, I: demoI, J: demoJ };
export function scenarioById(id: string): ScenarioDefinition {
  if (!(SCENARIO_IDS as readonly string[]).includes(id)) throw new UsageError(`Unknown scenario ${id.slice(0, 40)}; choose A–J.`);
  return SCENARIOS[id as ScenarioId];
}
export function parseScenarioList(raw: string): ScenarioId[] {
  const ids = raw.split(",").map((id) => id.trim());
  const seen = new Set<string>();
  return ids.map((id) => { scenarioById(id); if (seen.has(id)) throw new UsageError(`Duplicate scenario ${id}.`); seen.add(id); return id as ScenarioId; });
}
