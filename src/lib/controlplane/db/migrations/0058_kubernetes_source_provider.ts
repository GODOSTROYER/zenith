/**
 * J6 native Kubernetes approved source custody. Widen only the existing provider CHECK.
 * Every other condition, archive-format binding, immutability trigger and RLS rule stays intact.
 * Registered contract migration: apply only after explicitly admitting version 58.
 */
export const migration0058KubernetesSourceProvider = {
  version: 58,
  name: "kubernetes_source_provider",
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
    if c.def like '%''kubernetes''::text%' then
      continue;
    end if;
    widened := replace(c.def, '''zenith''::text]', '''zenith''::text, ''kubernetes''::text]');
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
