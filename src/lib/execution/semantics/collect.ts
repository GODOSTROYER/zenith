/**
 * Gathering the inputs of the canonical semantics digest from the trusted loaded authorities
 * (the product store, the resolved connection, the rendered workspace, the ownership registry,
 * the approved-source capture). Nothing here reads a workflow or model supplied claim.
 *
 * The same function runs at plan time (what the approver is shown), at the pre-apply re-plan,
 * and at dispatch, so a difference between those calls is exactly a change of executable semantics.
 */
import { z } from "zod";
import { semanticsOfInputs } from "../typed-inputs";
import { digest, sha256Hex } from "@/lib/controlplane/digest";
import { assessMigration } from "@/lib/release-safety/classify";
import type { MigrationClass } from "@/lib/release-safety/types";
import type { ResourceGraph } from "@/lib/resources/types";
import type { BuildPipelineSpec } from "@/lib/resources/specs";
import { TOFU_VERSION, type TofuWorkspace } from "@/lib/tofu/types";
import type { ExecContext } from "../context";
import { buildDesiredState } from "../graph";
import type { Runtime } from "../runtime";
import { computeExecutableSemantics, type ExecutableSemantics, type ExecutableSemanticsInputs } from "./digest";

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * An operation may name the signed runbook version it executes (MACH-03). The runbook service signs
 * the definition and records its digest; the operation carries the (id, version, definitionDigest)
 * triple in its immutable proposal input, so it is part of what the proposal digest approved AND of
 * the semantics digest. Absent means the operation executes no runbook.
 */
export const RunbookReference = z.object({ runbookId: z.string().min(1).max(200), version: z.number().int().min(1).max(1_000_000), definitionDigest: z.string().regex(HEX64) }).strict();

export function runbookOf(input: unknown): ExecutableSemanticsInputs["runbook"] {
  const raw = input && typeof input === "object" ? (input as { runbook?: unknown }).runbook : undefined;
  if (raw === undefined) return null;
  const parsed = RunbookReference.safeParse(raw);
  // A malformed runbook claim must never be silently dropped: it makes the semantics unique to this claim.
  return parsed.success ? parsed.data : { runbookId: "invalid", version: 0, definitionDigest: digest(raw) };
}

export interface CollectArgs {
  graph: ResourceGraph;
  connection: { id: string; config: unknown };
  /** the rendered, pinned workspace this execution will plan or apply */
  ws: Pick<TofuWorkspace, "files" | "configDigest" | "lockDigest" | "backend">;
  /** Native declarative engines bind their own contract version. */
  engineVersion?: string;
  /** the saved plan the human reviewed; null before any plan exists */
  planDigest: string | null;
}

/** Pure assembly of the inputs from already-loaded authorities. */
export async function collectSemanticsInputs(rt: Pick<Runtime, "d">, ec: ExecContext, args: CollectArgs): Promise<ExecutableSemanticsInputs> {
  const { graph, connection, ws } = args;
  const revision = ec.product.revision;
  const manifest = buildDesiredState(ec.product).manifest;
  const migrate = manifest?.release?.migrate;
  const assessment = migrate ? assessMigration({ declared: migrate.class as MigrationClass | undefined }) : undefined;
  const addresses = new Set(graph.nodes.map((n) => n.address));
  const transfers = ((await rt.d.resources.activeOwnershipTransfers?.(ec.workspaceId, ec.environmentId)) ?? []).filter((t) => addresses.has(t.address));
  const adoptions = (await rt.d.portability?.adoptionFacts(ec.workspaceId, ec.environmentId)) ?? [];
  const backendFile = ws.files.find((f) => f.path === "backend.tf.json");
  return {
    revision: { id: revision?.id ?? null, deployedRevisionId: ec.product.environment.deployedRevisionId ?? null, manifestDigest: revision ? digest(revision.manifest) : null },
    recipe: {
      executableSourceDigest: ec.executableSourceDigest ?? null,
      sources: (ec.approvedSourceSnapshots ?? []).map((s) => ({ service: s.serviceAddress, commit: s.commitSha, dockerfileDigest: s.dockerfileDigest, recipeDigest: s.recipeDigest, archiveDigest: s.archiveDigest })),
    },
    scripts: { release: migrate ? { service: migrate.service, commandDigest: digest(migrate.command), timeoutSec: migrate.timeoutSec ?? null } : null },
    migrations: migrate && assessment ? { declaredClass: (migrate.class as MigrationClass | undefined) ?? null, effectiveClass: assessment.class, sqlDigest: assessment.sqlDigest ?? null } : null,
    targets: {
      graphDigest: graph.graphDigest,
      provider: ec.product.environment.provider,
      region: ec.product.environment.region,
      environmentId: ec.environmentId,
      connectionId: connection.id,
      connectionConfigDigest: digest(connection.config ?? null),
    },
    configuration: { configDigest: ws.configDigest, ...(ec.typedInputs?.length ? { typedInputs: semanticsOfInputs(ec.typedInputs) } : {}) },
    providerLocks: { lockDigest: ws.lockDigest, tofuVersion: args.engineVersion ?? TOFU_VERSION },
    backend: { kind: ws.backend, configDigest: backendFile ? sha256Hex(backendFile.content) : null },
    savedPlan: { planDigest: args.planDigest },
    provenance: {
      ...(["kubernetes", "zenith"].includes(ec.product.environment.provider) &&
        graph.nodes.some(n => (n.spec.artifact as { type?: string } | undefined)?.type === "built") && rt.d.buildProfile
        ? { buildProfileDigest: rt.d.buildProfile({ workspaceId: ec.workspaceId, environmentId: ec.environmentId, provider: ec.product.environment.provider }) } : {}),
      pipelines: graph.nodes
        .filter((n) => n.kind === "build_pipeline")
        .map((n) => {
          const source = (n.spec as unknown as BuildPipelineSpec).source;
          return { service: n.address, contextDir: source.contextDir ?? null, contextDigest: source.contextDigest ?? null };
        }),
    },
    ownership: { transfers: transfers.map((t) => ({ address: t.address, path: t.path, from: String(t.from), to: String(t.to), digest: t.digest })) },
    runbook: runbookOf(ec.op.proposal.input),
    decommission: { adoptions: adoptions.map((a) => ({ address: a.address, externalId: a.externalId, status: a.status, lifecycle: a.lifecycle })) },
  };
}

/** The canonical semantics of the executable effect right now. */
export async function collectExecutableSemantics(rt: Pick<Runtime, "d">, ec: ExecContext, args: CollectArgs): Promise<ExecutableSemantics> {
  return computeExecutableSemantics(await collectSemanticsInputs(rt, ec, args));
}
