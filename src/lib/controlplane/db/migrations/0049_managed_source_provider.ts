/**
 * PROD-MAN-01: approved source snapshots may name the Zenith-managed provider.
 *
 * Migration 13's table-level CHECK admits `snapshot->>'provider' in ('aws','gcp','azure')`. A source build
 * on the Zenith-operated cluster records provider `zenith`, with the same `tar.gz` archive format as GCP and
 * Azure (the existing `case when provider='aws' then 'zip' else 'tar.gz'` already covers it). Nothing else in
 * the constraint changes: it is rewritten from its own deparsed definition so no other condition can drift.
 *
 * Idempotent: a constraint that already admits `zenith` is left alone. Existing rows all satisfy the wider
 * check; the immutability triggers fire on row writes only and are not involved.
 */
export const migration0049ManagedSourceProvider = {
  version: 49,
  name: "managed_source_provider",
  sql: `
do $$
declare
  c record;
  widened text;
  found boolean := false;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conrelid = 'platform.approved_source_snapshots'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%''azure''::text%'
       and pg_get_constraintdef(oid) like '%tar.gz%'
  loop
    found := true;
    if c.def like '%''zenith''::text%' then
      continue;
    end if;
    widened := replace(c.def, '''azure''::text]', '''azure''::text, ''zenith''::text]');
    if widened = c.def then
      raise exception 'approved_source_snapshots provider constraint has an unexpected shape';
    end if;
    execute format('alter table platform.approved_source_snapshots drop constraint %I', c.conname);
    execute format('alter table platform.approved_source_snapshots add constraint %I %s', c.conname, widened);
  end loop;
  if not found then
    raise exception 'approved_source_snapshots provider constraint was not found';
  end if;
end $$;
`,
};
