/**
 * Repair PostgreSQL's 255-repeat regex limit without changing the accepted
 * external-effect key alphabet or the intended 256-character maximum.
 * Published migration 33 and its checksum remain unchanged.
 */
import type { PlatformMigration } from "./index";

export const migration0042ExternalEffectKeyBounds: PlatformMigration = {
  version: 42,
  name: "external_effect_key_bounds",
  sql: `
alter table platform.external_effects
  drop constraint if exists external_effects_dedup_key_check,
  drop constraint if exists external_effects_idempotency_token_check,
  add constraint external_effects_dedup_key_check
    check (char_length(dedup_key) between 1 and 256 and dedup_key ~ '^[A-Za-z0-9_.:/=+-]+$'),
  add constraint external_effects_idempotency_token_check
    check (idempotency_token is null or
      (char_length(idempotency_token) between 1 and 256 and idempotency_token ~ '^[A-Za-z0-9_.:-]+$'));
`,
};
