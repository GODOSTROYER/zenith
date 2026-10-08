/** Expand-only W5-GAPS: separate restore completion evidence and explicit legacy key audit. */
export const migration0058Wave5Gaps = {
  version: 58,
  name: "wave5_gaps",
  sql: `
alter table platform.slo_measurements drop constraint if exists slo_measurements_kind_check;
alter table platform.slo_measurements add constraint slo_measurements_kind_check
  check (kind in ('rpo','rto','capacity','database_restore','application_health'));
alter table platform.slo_measurements drop constraint if exists slo_measurements_check;
alter table platform.slo_measurements add constraint slo_measurements_check
  check ((kind in ('rpo','rto','database_restore','application_health') and unit = 'seconds') or (kind = 'capacity' and unit = 'requests_per_second'));
alter table platform.retention_restores add column if not exists key_purpose text
  check (key_purpose is null or key_purpose in ('enc:archive','enc:backup'));
alter table platform.retention_restores add column if not exists restore_key_id text
  check (restore_key_id is null or char_length(restore_key_id) between 1 and 128);
alter table platform.retention_restores add column if not exists legacy_reason text
  check (legacy_reason is null or legacy_reason ~ '^[A-Za-z0-9 ._:/()-]{1,200}$');
`,
} as const;
