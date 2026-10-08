/**
 * The ONE canonical "executable semantics digest" (PROD-DUR-03).
 *
 * An approval is a statement about what will actually run. Before this module the
 * pieces of "what will run" were checked in different places (plan digest, custody
 * source digest, deployed-workspace comparison, migration binding). The semantics
 * digest folds every input that can change the executable effect into one value so
 * that approval binds to it and dispatch recomputes it:
 *
 *   revision        the revision id being deployed, the revision currently deployed, and the manifest digest
 *   recipe          approved source snapshots (commit, Dockerfile, build recipe, archive; LIFE-08)
 *   scripts         the release command argv digest, target service and timeout (never the argv text)
 *   migrations      the LIFE-10 class (declared raised by observed SQL) and the SQL digest
 *   targets         graph digest, provider, region, environment, connection identity and configuration
 *   configuration   the rendered OpenTofu configuration digest
 *   providerLocks   the provider lock-file digest and OpenTofu version
 *   backend         the state backend kind and its rendered configuration digest
 *   savedPlan       the digest of the saved plan the human reviewed
 *   provenance      the build context directory and inspected context digest of every pipeline (LIFE-08/09); the
 *                   signed build provenance itself is produced AFTER approval and is verified against the recipe at admission
 *   ownership       the active field-ownership transfers in force (LIFE-12)
 *   runbook         the signed runbook version and definition digest the operation names (MACH-03)
 *   decommission    the adoption claims (address, external id, status, lifecycle) that decide what a delete may touch (LIFE-11)
 *
 * Each component is hashed on its own so a refusal can name WHICH input moved
 * (component names only, never values). The overall digest hashes the component
 * digests. Arrays are normalised (sorted) so ordering alone never invalidates an approval;
 * `undefined` and absent are the same.
 *
 * Nothing secret enters: inputs are ids, digests, classes and counts.
 */
import { digest } from "@/lib/controlplane/digest";
import type { MigrationClass } from "@/lib/release-safety/types";

export const SEMANTICS_FORMAT = "zenith.executable-semantics.v1" as const;

export const SEMANTIC_COMPONENTS = [
  "revision",
  "recipe",
  "scripts",
  "migrations",
  "targets",
  "configuration",
  "providerLocks",
  "backend",
  "savedPlan",
  "provenance",
  "ownership",
  "runbook",
  "decommission",
] as const;
export type SemanticComponentName = (typeof SEMANTIC_COMPONENTS)[number];

const HEX64 = /^[0-9a-f]{64}$/;

export interface SourceSemantics {
  service: string;
  commit: string;
  dockerfileDigest: string;
  recipeDigest: string;
  archiveDigest: string;
}

export interface PipelineProvenanceSemantics {
  service: string;
  contextDir: string | null;
  contextDigest: string | null;
}

export interface OwnershipTransferSemantics {
  address: string;
  path: string;
  from: string;
  to: string;
  digest: string;
}

export interface ExecutableSemanticsInputs {
  revision: { id: string | null; deployedRevisionId: string | null; manifestDigest: string | null };
  recipe: { executableSourceDigest: string | null; sources: SourceSemantics[] };
  scripts: { release: { service: string; commandDigest: string; timeoutSec: number | null } | null };
  migrations: { declaredClass: MigrationClass | null; effectiveClass: MigrationClass; sqlDigest: string | null } | null;
  targets: { graphDigest: string; provider: string; region: string; environmentId: string; connectionId: string; connectionConfigDigest: string };
  /** `typedInputs` is present only for a mixed-provider consumer: names, types and digests of the producer outputs it consumes. */
  configuration: { configDigest: string; typedInputs?: { name: string; type: string; valueDigest: string; secretRef?: string; versionDigest?: string }[] };
  providerLocks: { lockDigest: string; tofuVersion: string | null };
  backend: { kind: string; configDigest: string | null };
  savedPlan: { planDigest: string | null };
  provenance: { pipelines: PipelineProvenanceSemantics[]; buildProfileDigest?: string };
  ownership: { transfers: OwnershipTransferSemantics[] };
  runbook: { runbookId: string; version: number; definitionDigest: string } | null;
  decommission: { adoptions: { address: string; externalId: string; status: string; lifecycle: string }[] };
}

export type SemanticsComponents = Readonly<Record<SemanticComponentName, string>>;

export interface ExecutableSemantics {
  format: typeof SEMANTICS_FORMAT;
  digest: string;
  components: SemanticsComponents;
}

const byKey = <T>(items: readonly T[], key: (item: T) => string): T[] => [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/** The normalised value each component hashes. Exported so tests can prove what is covered. */
export function normalizedComponent(name: SemanticComponentName, inputs: ExecutableSemanticsInputs): unknown {
  switch (name) {
    case "revision":
      return inputs.revision;
    case "recipe":
      return { executableSourceDigest: inputs.recipe.executableSourceDigest, sources: byKey(inputs.recipe.sources, (s) => s.service) };
    case "scripts":
      return inputs.scripts;
    case "migrations":
      return inputs.migrations;
    case "targets":
      return inputs.targets;
    case "configuration":
      // A consumer's consumed output digests are part of its configuration: a changed producer output moves this component.
      return inputs.configuration.typedInputs?.length
        ? { configDigest: inputs.configuration.configDigest, typedInputs: byKey(inputs.configuration.typedInputs, (item) => item.name) }
        : { configDigest: inputs.configuration.configDigest };
    case "providerLocks":
      return inputs.providerLocks;
    case "backend":
      return inputs.backend;
    case "savedPlan":
      return inputs.savedPlan;
    case "provenance":
      return { pipelines: byKey(inputs.provenance.pipelines, (p) => p.service), ...(inputs.provenance.buildProfileDigest ? { buildProfileDigest: inputs.provenance.buildProfileDigest } : {}) };
    case "ownership":
      return { transfers: byKey(inputs.ownership.transfers, (t) => `${t.address}\u0000${t.path}\u0000${t.digest}`) };
    case "runbook":
      return inputs.runbook;
    case "decommission":
      return { adoptions: byKey(inputs.decommission.adoptions, (a) => a.address + "\u0000" + a.externalId) };
  }
}

/** Compute the canonical semantics. Pure and deterministic. */
export function computeExecutableSemantics(inputs: ExecutableSemanticsInputs): ExecutableSemantics {
  const components = {} as Record<SemanticComponentName, string>;
  for (const name of SEMANTIC_COMPONENTS) components[name] = digest({ format: SEMANTICS_FORMAT, component: name, value: normalizedComponent(name, inputs) ?? null });
  return { format: SEMANTICS_FORMAT, digest: digest({ format: SEMANTICS_FORMAT, components }), components };
}

/** The stored semantics document when it is well formed and its digest matches its components, else undefined. */
export function readExecutableSemantics(value: unknown): ExecutableSemantics | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { format?: unknown; digest?: unknown; components?: unknown };
  if (v.format !== SEMANTICS_FORMAT || typeof v.digest !== "string" || !HEX64.test(v.digest) || !v.components || typeof v.components !== "object") return undefined;
  const components = {} as Record<SemanticComponentName, string>;
  for (const name of SEMANTIC_COMPONENTS) {
    const c = (v.components as Record<string, unknown>)[name];
    if (typeof c !== "string" || !HEX64.test(c)) return undefined;
    components[name] = c;
  }
  if (Object.keys(v.components as object).length !== SEMANTIC_COMPONENTS.length) return undefined;
  if (digest({ format: SEMANTICS_FORMAT, components }) !== v.digest) return undefined;
  return { format: SEMANTICS_FORMAT, digest: v.digest, components };
}

/** Names of the components whose digest differs. Empty means the semantics are identical. */
export function diffSemantics(approved: Pick<ExecutableSemantics, "components">, current: Pick<ExecutableSemantics, "components">): SemanticComponentName[] {
  return SEMANTIC_COMPONENTS.filter((name) => approved.components[name] !== current.components[name]);
}

