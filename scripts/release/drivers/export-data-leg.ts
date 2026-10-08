// Shared contract for the operated export data roundtrip (DRV-4 split across three workers).
// Each leg seeds known tenant data into its owned SOURCE engine, reads the imported TARGET back,
// and removes only the resources it owns. Witnesses come from export-data-plan.ts so equality is uniform.
import type { DataKind, Witness } from "./export-data-plan";

export interface LegEndpoint {
  /** Connection URL or endpoint for an owned local container (never a shared or production endpoint). */
  url: string;
  /** Private-CA bundle path when the engine requires verified TLS (MySQL). */
  caFile?: string;
  /** Bucket name for object stores. */
  bucket?: string;
  /** Credentials generated at runtime for the owned container; never literals in source. */
  user?: string;
  password?: string;
}

export interface LegContext {
  runId: string;
  /** Tenant whose data is exported; the other tenant's data is seeded too and must NOT appear in the target. */
  tenant: "a" | "b";
  source: LegEndpoint;
  target: LegEndpoint;
  /** Ownership label applied to every resource this leg creates (cleanup removes only these). */
  ownerLabel: string;
}

export interface DataLeg {
  kind: DataKind;
  /** Pinned container image (from pinnedFixtureImages) the orchestrator starts for source and target. */
  image(env: Readonly<Record<string, string | undefined>>): string;
  /**
   * Seed both tenants into SEPARATE export units: tenant_a/tenant_b databases,
   * or drv4-<runId>-data-a/b buckets. LIFE-11 exports a whole database/bucket.
   * SQL endpoints are admin endpoints; object endpoint.bucket selects ctx.tenant.
   * Create the corresponding empty target databases/buckets too. Preserve
   * knownData row fields and object keys; return an independent source witness.
   */
  seedSource(ctx: LegContext): Promise<Witness>;
  /** Read ctx.tenant from target (including fresh empty targets or source-as-target readback). */
  readTarget(ctx: LegContext): Promise<Witness>;
  /** Fail if any row/object of the other tenant reached the target. */
  assertNoForeignTenant(ctx: LegContext): Promise<void>;
  /** Remove both tenants' resources on source and target, attempting both even after failure; idempotent and ownership checked. */
  cleanup(ctx: LegContext): Promise<void>;
}
