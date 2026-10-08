/**
 * TEMPORARY TYPE-ONLY STUBS, explicitly authorized by the DRV-4 split handoff.
 * Orchestrator: remove this file when merging DRV-4M and DRV-4O implementations.
 * No runtime implementations exist here. Missing helper files still fail the
 * operated driver import and scenario file inventory; no evidence is promoted.
 */
type DRV4TemporaryDataLeg = import("./export-data-leg").DataLeg;
declare module "*export-data-mysql" { export const mysqlLeg: DRV4TemporaryDataLeg; }
declare module "*export-data-objects" { export const objectStoreLeg: DRV4TemporaryDataLeg; }
