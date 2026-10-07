/**
 * Postgres `StandingGrantStore` (PROD-DUR-04). Every statement filters on `workspace_id`; values
 * are `$n` parameters. A use is reserved with ONE guarded UPDATE (`uses < max_uses`, active,
 * unexpired), so concurrent callers can never exceed the count; the table CHECK and trigger
 * enforce the same bound again.
 */
import type { Sql } from "@/lib/controlplane/types";
import type { CapabilityRisk } from "@/lib/capabilities/catalog";
import type { NewStandingGrant, ReserveUseResult, StandingGrant, StandingGrantStore, StandingGrantUse } from "@/lib/capabilities/standing-grants";
import { json } from "../sql";

type Row = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const parse = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));
const isUnique = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

const COLS = "id, workspace_id, created_by, created_by_name, project_id, environment_id, resource_id, capabilities, max_risk, allowed_principals, max_uses, uses, expires_at, created_at, status, revoked_at, revoked_by, revoked_reason";
const USE_COLS = "id, workspace_id, grant_id, operation_id, principal_key, approval_id, created_at, voided_at";

const grantOf = (r: Row): StandingGrant => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  createdBy: r.created_by as string,
  createdByName: r.created_by_name as string,
  ...(r.project_id ? { projectId: r.project_id as string } : {}),
  environmentId: r.environment_id as string,
  ...(r.resource_id ? { resourceId: r.resource_id as string } : {}),
  capabilities: parse<string[]>(r.capabilities),
  maxRisk: r.max_risk as CapabilityRisk,
  allowedPrincipals: parse<string[]>(r.allowed_principals),
  maxUses: Number(r.max_uses),
  uses: Number(r.uses),
  expiresAt: iso(r.expires_at),
  createdAt: iso(r.created_at),
  status: r.status as StandingGrant["status"],
  ...(r.revoked_at ? { revokedAt: iso(r.revoked_at) } : {}),
  ...(r.revoked_by ? { revokedBy: r.revoked_by as string } : {}),
  ...(r.revoked_reason ? { revokedReason: r.revoked_reason as string } : {}),
});

const useOf = (r: Row): StandingGrantUse => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  grantId: r.grant_id as string,
  operationId: r.operation_id as string,
  principalKey: r.principal_key as string,
  ...(r.approval_id ? { approvalId: r.approval_id as string } : {}),
  createdAt: iso(r.created_at),
  ...(r.voided_at ? { voidedAt: iso(r.voided_at) } : {}),
});

export function createPlatformStandingGrantStore(db: Sql): StandingGrantStore {
  const store: StandingGrantStore = {
    async create(grant: NewStandingGrant): Promise<StandingGrant> {
      const rows = await db.query<Row>(
        `insert into platform.standing_grants(id, workspace_id, created_by, created_by_name, project_id, environment_id, resource_id, capabilities, max_risk, allowed_principals, max_uses, expires_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb,$9,$10::text::jsonb,$11,$12::timestamptz,$13::timestamptz) returning ${COLS}`,
        [grant.id, grant.workspaceId, grant.createdBy, grant.createdByName, grant.projectId ?? null, grant.environmentId, grant.resourceId ?? null, json(grant.capabilities), grant.maxRisk, json(grant.allowedPrincipals), grant.maxUses, grant.expiresAt, grant.createdAt]
      );
      return grantOf(rows[0]);
    },

    async get(workspaceId: string, id: string): Promise<StandingGrant | null> {
      const rows = await db.query<Row>(`select ${COLS} from platform.standing_grants where workspace_id = $1 and id = $2`, [workspaceId, id]);
      return rows[0] ? grantOf(rows[0]) : null;
    },

    async list(workspaceId: string, filter: { environmentId?: string; activeOnly?: boolean; now?: Date; limit?: number } = {}): Promise<StandingGrant[]> {
      const now = (filter.now ?? new Date()).toISOString();
      const rows = await db.query<Row>(
        `select ${COLS} from platform.standing_grants
          where workspace_id = $1 and ($2::text is null or environment_id = $2)
            and (not $3::boolean or (status = 'active' and expires_at > $4::timestamptz and uses < max_uses))
          order by created_at, id limit $5`,
        [workspaceId, filter.environmentId ?? null, filter.activeOnly === true, now, Math.max(1, Math.min(200, filter.limit ?? 100))]
      );
      return rows.map(grantOf);
    },

    async revoke(input: { workspaceId: string; id: string; revokedBy: string; reason?: string; at: Date }): Promise<StandingGrant | null> {
      const rows = await db.query<Row>(
        `update platform.standing_grants set status = 'revoked', revoked_at = $4::timestamptz, revoked_by = $3, revoked_reason = $5
          where workspace_id = $1 and id = $2 and status = 'active' returning ${COLS}`,
        [input.workspaceId, input.id, input.revokedBy, input.at.toISOString(), input.reason ?? null]
      );
      if (rows[0]) return grantOf(rows[0]);
      return store.get(input.workspaceId, input.id);
    },

    async reserveUse(input: { workspaceId: string; grantId: string; useId: string; operationId: string; principalKey: string; now: Date }): Promise<ReserveUseResult> {
      try {
        return await db.tx(async (tx): Promise<ReserveUseResult> => {
          const now = input.now.toISOString();
          const bumped = await tx.query<Row>(
            `update platform.standing_grants set uses = uses + 1
              where workspace_id = $1 and id = $2 and status = 'active' and expires_at > $3::timestamptz and uses < max_uses
              returning ${COLS}`,
            [input.workspaceId, input.grantId, now]
          );
          if (!bumped[0]) {
            const current = await tx.query<Row>(`select ${COLS} from platform.standing_grants where workspace_id = $1 and id = $2`, [input.workspaceId, input.grantId]);
            const g = current[0] ? grantOf(current[0]) : undefined;
            if (!g) return { ok: false, reason: "not_found" };
            if (g.status !== "active") return { ok: false, reason: "revoked" };
            if (Date.parse(g.expiresAt) <= input.now.getTime()) return { ok: false, reason: "expired" };
            return { ok: false, reason: "exhausted" };
          }
          const uses = await tx.query<Row>(
            `insert into platform.standing_grant_uses(id, workspace_id, grant_id, operation_id, principal_key, created_at)
             values ($1,$2,$3,$4,$5,$6::timestamptz) returning ${USE_COLS}`,
            [input.useId, input.workspaceId, input.grantId, input.operationId, input.principalKey, now]
          );
          return { ok: true, grant: grantOf(bumped[0]), use: useOf(uses[0]) };
        });
      } catch (error) {
        // The partial unique index: this operation already used this grant. The whole transaction rolled back, so no count was spent.
        if (isUnique(error)) return { ok: false, reason: "exhausted" };
        throw error;
      }
    },

    async attachApproval(input: { workspaceId: string; useId: string; approvalId: string }): Promise<boolean> {
      const rows = await db.query<Row>(
        `update platform.standing_grant_uses set approval_id = $3 where workspace_id = $1 and id = $2 and approval_id is null and voided_at is null returning id`,
        [input.workspaceId, input.useId, input.approvalId]
      );
      return rows.length === 1;
    },

    async voidUse(input: { workspaceId: string; useId: string; at: Date }): Promise<boolean> {
      return db.tx(async (tx) => {
        const rows = await tx.query<Row>(
          `update platform.standing_grant_uses set voided_at = $3::timestamptz where workspace_id = $1 and id = $2 and approval_id is null and voided_at is null returning grant_id`,
          [input.workspaceId, input.useId, input.at.toISOString()]
        );
        if (!rows[0]) return false;
        await tx.query(`update platform.standing_grants set uses = uses - 1 where workspace_id = $1 and id = $2 and uses > 0`, [input.workspaceId, rows[0].grant_id]);
        return true;
      });
    },

    async usesForOperation(workspaceId: string, operationId: string): Promise<StandingGrantUse[]> {
      const rows = await db.query<Row>(`select ${USE_COLS} from platform.standing_grant_uses where workspace_id = $1 and operation_id = $2 order by created_at, id limit 100`, [workspaceId, operationId]);
      return rows.map(useOf);
    },
    async usesForGrant(workspaceId: string, grantId: string, limit = 50): Promise<StandingGrantUse[]> {
      const rows = await db.query<Row>(`select ${USE_COLS} from platform.standing_grant_uses where workspace_id = $1 and grant_id = $2 order by created_at desc, id limit $3`, [workspaceId, grantId, Math.max(1, Math.min(200, limit))]);
      return rows.map(useOf);
    },
  };
  return store;
}
