/** Read-only canonical agent grant schema check. No .env loading, DDL or credential diagnostics. */
import { pathToFileURL } from "node:url";
import { createPgAuthorityClient, type Sql } from "@/lib/hosted/authority/pg/client";
import { AGENT_CONTROL_MIGRATIONS, OAUTH_GRANT_COLUMNS, OAUTH_GRANT_CONSTRAINTS, OAUTH_GRANT_IDENTITY_TRIGGER, OAUTH_GRANT_FUNCTIONS } from "@/lib/agent-access/control/journal-pg";

export class AgentGrantSchemaError extends Error {
  constructor() { super("The canonical agent OAuth grant schema could not be verified."); }
}
const refuse = (): never => { throw new AgentGrantSchemaError(); };

/** Ledger names/versions and native structure/privileges; the historical agent ledger has no checksums. */
export async function verifyAgentSchema(client: Sql): Promise<void> {
  await client.begin(async sql => {
    // Stable native deparsing, with no schema writes or caller search-path authority.
    await sql`set local search_path = pg_catalog`;
    const ledger = await sql`select version, name from agent.schema_migrations order by version`;
    if (AGENT_CONTROL_MIGRATIONS.some(required => !ledger.some(row => Number(row.version) === required.version && row.name === required.name))
      || new Set(ledger.map(row => Number(row.version))).size !== ledger.length) return refuse();
    const columns = await sql`select column_name, data_type, is_nullable from information_schema.columns
      where table_schema = 'agent' and table_name = 'agent_oauth_grants' order by ordinal_position`;
    if (JSON.stringify(columns.map(row => ({ name: row.column_name, type: row.data_type, nullable: row.is_nullable === 'YES' })))
      !== JSON.stringify(OAUTH_GRANT_COLUMNS)) return refuse();
    const constraints = await sql`select c.conname as name, c.contype::text as type, c.conkey::text as columns,
      pg_get_constraintdef(c.oid, false) as definition,
      c.convalidated and not c.condeferrable and not c.condeferred and c.conislocal
        and c.coninhcount = 0 and c.connoinherit = (c.contype in ('p','u')) and c.conparentid = 0 as canonical_flags,
      case when c.contype = 'c' then c.conindid = 0 else exists (
        select 1 from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_am am on am.oid = ic.relam
        where i.indexrelid = c.conindid and i.indrelid = c.conrelid and ic.relname = c.conname
          and i.indisunique and i.indimmediate and i.indisvalid and i.indisready and i.indislive
          and i.indisprimary = (c.contype = 'p') and not i.indisexclusion
          and i.indnatts = cardinality(c.conkey) and i.indnkeyatts = cardinality(c.conkey)
          and i.indkey::text = array_to_string(c.conkey, ' ') and i.indexprs is null and i.indpred is null
          and am.amname = 'btree'
          and not exists (select 1 from unnest(i.indclass::oid[]) as classes(opclass)
            join pg_opclass op on op.oid = classes.opclass join pg_namespace ns on ns.oid = op.opcnamespace
            where op.opcname <> 'text_ops' or ns.nspname <> 'pg_catalog')
          and array(select unnest(i.indcollation::oid[])) = (select array_agg(a.attcollation order by keys.position)
            from unnest(c.conkey) with ordinality as keys(attnum,position)
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = keys.attnum)
        ) end as canonical_index
      from pg_constraint c where c.conrelid = to_regclass('agent.agent_oauth_grants') order by c.conname`;
    if (constraints.some(row => row.canonical_flags !== true || row.canonical_index !== true)
      || JSON.stringify(constraints.map(({ name, type, columns, definition }) => ({ name, type, columns, definition })))
        !== JSON.stringify(OAUTH_GRANT_CONSTRAINTS)) return refuse();
    const triggers = await sql`select t.tgname::text as name, t.tgtype::integer as type, t.tgenabled::text as enabled,
      t.tgattr::text as columns, t.tgqual::text as condition, t.tgnargs::integer as argument_count,
      octet_length(t.tgargs) as argument_bytes, t.tgparentid::integer as parent,
      t.tgconstraint::integer as constraint_id, t.tgconstrrelid::integer as constraint_relation,
      t.tgconstrindid::integer as constraint_index, t.tgdeferrable as deferrable, t.tginitdeferred as initially_deferred,
      t.tgoldtable::text as old_table, t.tgnewtable::text as new_table,
      t.tgfoid = to_regprocedure('agent.guard_oauth_grant_identity()') as original_function
      from pg_trigger t where t.tgrelid = to_regclass('agent.agent_oauth_grants') and not t.tgisinternal order by t.tgname`;
    if (triggers.length !== 1 || triggers[0].original_function !== true
      || JSON.stringify(triggers.map(row => ({ name: row.name, type: Number(row.type), enabled: row.enabled,
        columns: row.columns, condition: row.condition, argumentCount: Number(row.argument_count),
        argumentBytes: Number(row.argument_bytes), parent: Number(row.parent), constraint: Number(row.constraint_id),
        constraintRelation: Number(row.constraint_relation), constraintIndex: Number(row.constraint_index),
        deferrable: row.deferrable, initiallyDeferred: row.initially_deferred, oldTable: row.old_table, newTable: row.new_table })))
        !== JSON.stringify([OAUTH_GRANT_IDENTITY_TRIGGER])) return refuse();
    const functions = await sql`select p.proname::text as name, n.nspname::text as schema, l.lanname::text as language,
      p.prokind::text as kind, format_type(p.prorettype, null) as result_type,
      p.pronargs::integer as argument_count, p.proargtypes::text as argument_types, p.proargnames as argument_names,
      p.proallargtypes as all_argument_types, p.proargmodes as argument_modes,
      p.pronargdefaults::integer as default_count, p.proargdefaults::text as argument_defaults,
      p.provariadic::integer as variadic, p.prosecdef as security_definer, p.proisstrict as strict,
      p.proleakproof as leakproof, p.proretset as returns_set, p.provolatile::text as volatility, p.proparallel::text as parallel,
      p.proconfig as config, p.probin as binary, p.prosqlbody::text as sql_body,
      p.protrftypes as transforms, p.prosupport::oid::integer as support, p.prosrc as body,
      (select count(*)::integer from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) where grantee = 0) as public_grants
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
      where p.oid in (to_regprocedure('agent.guard_oauth_grant_identity()'),
        to_regprocedure('agent.oauth_grant_ids_valid(jsonb,integer,integer)')) order by p.proname`;
    if (functions.some(row => Number(row.public_grants) !== 0)
      || JSON.stringify(functions.map(row => ({ name: row.name, schema: row.schema, language: row.language,
        kind: row.kind, resultType: row.result_type, argumentCount: Number(row.argument_count), argumentTypes: row.argument_types,
        argumentNames: row.argument_names, allArgumentTypes: row.all_argument_types, argumentModes: row.argument_modes,
        defaultCount: Number(row.default_count), argumentDefaults: row.argument_defaults, variadic: Number(row.variadic),
        securityDefiner: row.security_definer, strict: row.strict, leakproof: row.leakproof, returnsSet: row.returns_set,
        volatility: row.volatility, parallel: row.parallel, config: row.config, binary: row.binary, sqlBody: row.sql_body,
        transforms: row.transforms, support: Number(row.support), body: row.body }))) !== JSON.stringify(OAUTH_GRANT_FUNCTIONS)) return refuse();
    const boundary = await sql`select c.relrowsecurity as rls,
      (select count(*)::integer from pg_policy where polrelid = c.oid) as policies,
      (select count(*)::integer from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) where grantee = 0) as public_grants
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'agent' and c.relname = 'agent_oauth_grants' and c.relkind = 'r'`;
    if (boundary.length !== 1 || boundary[0].rls !== true || Number(boundary[0].policies) !== 0
      || Number(boundary[0].public_grants) !== 0) return refuse();
    const roles = await sql`select r.rolname, r.rolbypassrls, r.rolsuper,
      has_table_privilege(r.oid, 'agent.agent_oauth_grants', 'SELECT') as can_select,
      has_table_privilege(r.oid, 'agent.agent_oauth_grants', 'INSERT') as can_insert,
      has_table_privilege(r.oid, 'agent.agent_oauth_grants', 'UPDATE') as can_update,
      has_table_privilege(r.oid, 'agent.agent_oauth_grants', 'DELETE') as can_delete,
      has_table_privilege(r.oid, 'agent.agent_oauth_grants', 'TRUNCATE') as can_truncate,
      has_table_privilege(r.oid, 'agent.agent_oauth_grants', 'REFERENCES') as can_references,
      has_table_privilege(r.oid, 'agent.agent_oauth_grants', 'TRIGGER') as can_trigger,
      has_function_privilege(r.oid, 'agent.guard_oauth_grant_identity()', 'EXECUTE') as can_execute_guard,
      has_function_privilege(r.oid, 'agent.oauth_grant_ids_valid(jsonb,integer,integer)', 'EXECUTE') as can_execute_ids
      from pg_roles r where r.rolname in ('service_role', 'anon', 'authenticated') order by r.rolname`;
    if (roles.length !== 3) return refuse();
    for (const role of roles) {
      if (role.rolname === 'service_role') {
        if (role.rolbypassrls !== true || role.rolsuper !== false || role.can_select !== true || role.can_insert !== true || role.can_update !== true
          || role.can_execute_guard !== true || role.can_execute_ids !== true || role.can_delete !== false || role.can_truncate !== false || role.can_references !== false || role.can_trigger !== false) return refuse();
      } else if (role.rolbypassrls !== false || role.rolsuper !== false
        || ['can_select', 'can_insert', 'can_update', 'can_delete', 'can_truncate', 'can_references', 'can_trigger', 'can_execute_guard', 'can_execute_ids'].some(key => role[key] !== false)) return refuse();
    }
  });
}

type Output = { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } };
/** Only explicit approved lane configuration; fixed errors never print URI/SQL/row values. */
export async function verifyAgentSchemaMain(
  env: { SUPABASE_DB_URL?: string } = { SUPABASE_DB_URL: process.env.SUPABASE_DB_URL },
  open: typeof createPgAuthorityClient = createPgAuthorityClient,
  output: Output = process
): Promise<number> {
  const url = env.SUPABASE_DB_URL?.trim();
  if (!url) { output.stderr.write("::error::SUPABASE_DB_URL is not set; no agent lane database can be verified.\n"); return 1; }
  let client: Sql | undefined;
  try {
    client = open(url);
    await verifyAgentSchema(client);
    output.stdout.write("Known agent migration names/versions and OAuth grant structure/RLS/privileges verified; the agent ledger has no checksums.\n");
    return 0;
  } catch {
    output.stderr.write("::error::The canonical agent OAuth grant schema could not be verified; check lane connectivity, migrations and privileges.\n");
    return 1;
  } finally {
    if (client) await client.end({ timeout: 5 }).catch(() => undefined);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void verifyAgentSchemaMain().then(code => { process.exitCode = code; });
}
