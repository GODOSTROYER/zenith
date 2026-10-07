/**
 * Tenant isolation apply effects (PROD-MAN-04).
 *
 * The external-effect ledger (migration 33) records every provider mutation BEFORE it is dispatched. The managed
 * platform's tenant isolation bundle (hostname egress policy, operator access, quotas) is one such mutation, so it
 * gets its own effect family, `isolation_apply`: the family check on `external_effects` is widened and nothing else
 * changes (state machine, triggers, immutability and indexes are untouched).
 *
 * The constraint is dropped and re-created rather than altered in place; both statements are idempotent.
 */
import type { PlatformMigration } from "./index";

export const migration0050TenantIsolationEffects: PlatformMigration = {
  version: 50,
  name: "tenant_isolation_effects",
  sql: `
alter table platform.external_effects drop constraint if exists external_effects_family_check;
alter table platform.external_effects add constraint external_effects_family_check
  check (family in ('build_launch','cleanup_apply','proxy_request','isolation_apply'));
`,
};
