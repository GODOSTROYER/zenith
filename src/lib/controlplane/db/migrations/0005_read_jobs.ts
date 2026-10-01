/**
 * Migration 5 — runner reads need no operation row. The capability snapshot is
 * deliberately frozen: a later catalog addition requires another migration.
 * Composite tenant foreign keys remain in force for runners and operations.
 * Reads have their own bounded queue expiry and use the existing job lifecycle.
 */
export const READ_JOB_CAPABILITIES = [
  "infrastructure.observe", "topology.read", "logs.read", "metrics.read",
  "traces.read", "events.read", "incident.investigate", "cost.estimate",
  "firewall.inspect", "infrastructure.plan", "placement.solve", "machine.inspect",
  "process.list", "service.status", "container.list", "container.inspect",
  "container.logs", "file.read", "network.portCheck", "network.dnsCheck",
  "system.metrics", "system.logs",
] as const;

export const migration0005ReadJobs = {
  version: 5,
  name: "read_jobs",
  sql: `
alter table platform.runner_jobs alter column operation_id drop not null;
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'platform.runner_jobs'::regclass
                    and conname = 'runner_jobs_read_capability') then
    alter table platform.runner_jobs add constraint runner_jobs_read_capability
      check (operation_id is not null or capability in (${READ_JOB_CAPABILITIES.map((name) => `'${name}'`).join(", ")}));
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'platform.runner_jobs'::regclass
                    and conname = 'runner_jobs_read_expiry') then
    alter table platform.runner_jobs add constraint runner_jobs_read_expiry
      check (operation_id is not null or expires_at <= created_at + interval '1 hour');
  end if;
end
$$;
`,
} as const;
