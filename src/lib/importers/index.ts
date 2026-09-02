/**
 * The importers' public surface: one function per input format, each returning
 * a manifest plus an honest `ImportReport` (nothing is silently dropped).
 *
 * Nothing here touches the store, an action or the engine — an importer turns
 * text into a manifest and says what it could not translate. `./types` holds
 * the shared vocabulary and the naming helpers, and is imported directly by
 * the action defs and the import screens rather than re-exported here.
 */
export { importCompose, type ComposeImport } from "./compose";
export { importDockerfile, type DockerfileImport } from "./dockerfile";
export { importTerraform, type TerraformImport, TERRAFORM_IMPORTER_LABEL } from "./terraform";
export type { ImportReport, ImportMapped, ImportUnmapped } from "./types";
