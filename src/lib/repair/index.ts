/** The observation-to-repair lifecycle, one door: `@/lib/repair`. */
export { runRepairLifecycle, lifecycleItem, lifecycleItems, summarizeRepairs, type LifecycleDisposition, type LifecycleEntry, type LifecycleItem, type RepairLifecycleInput, type RepairLifecycleResult } from "./lifecycle";
export { refusal, refusalOf, type LifecycleStage, type RepairRefusal, type RepairRefusalCode } from "./refusals";
export { withDiagnosisRecording, type RecordInvestigation } from "./diagnosis";
