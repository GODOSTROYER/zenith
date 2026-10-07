/** Proposed storage contract only. This is not a published platform migration. */
export const updateControlSchema = `
create table platform.agent_update_controls (
 workspace_id text not null,
 kind text not null check (kind in ('runner','machine')),
 agent_id text not null,
 revision integer not null check (revision > 0),
 hold boolean not null,
 manifest_sha256 text check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
 requested_by text not null,
 updated_at timestamptz not null default clock_timestamp(),
 primary key (workspace_id, kind, agent_id),
 check (not hold or manifest_sha256 is null)
);`;
