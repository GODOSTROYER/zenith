/** Real platform and agent SQL plus the production PgCredentialAuthority.
 * The postgres.js tag is adapted to the same executor for PGlite. No cloud,
 * browser provider or container isolation is claimed by this fixture. */
import { readFile } from "node:fs/promises";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { PgCredentialAuthority } from "@/lib/agent-access/authority/pg";
import type { Sql } from "@/lib/hosted/authority/pg/client";
import { mintToken, hashToken } from "@/lib/agent-access/link/protocol";

export async function openLaunchPlatform() {
  const url = process.env.ZENITH_TEST_PLATFORM_PG_URL;
  const db = await openPlatformDb(url ? { kind: "postgres", url, migrate: true, max: 2 } : { kind: "pglite" });
  if (!url) {
    await db.exec("create role service_role");
    await db.exec(await readFile("supabase/migrations/0006_agent_link.sql", "utf8"));
  }
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((sql, part, i) => sql + (i ? `$${i}` : "") + part, "");
    const rows = await db.query(text, values);
    return Object.assign(rows, { count: rows.length });
  };
  const authority = new PgCredentialAuthority(() => tag as unknown as Sql);
  await authority.ready();
  return { db, authority };
}
export async function seedLaunchParent(db: PlatformDbHandle, workspaceId: string, subject = "bob") {
  const token = mintToken(); const id = `cred_${Math.random().toString(36).slice(2)}`;
  await db.query(`insert into agent.agent_credentials
    (id,token_hash,subject,workspace_id,project_ids,environment_ids,scopes,client_name,issued_at,expires_at,created_by)
    values ($1,$2,$3,$4,$5::text::jsonb,$6::text::jsonb,$7::text::jsonb,'test launcher parent',$8,$9,$3)`,
  [id, hashToken(token), subject, workspaceId, JSON.stringify(["proj-a", "proj-b"]), JSON.stringify(["env-a", "env-b"]),
    JSON.stringify(["read", "logs", "plan", "write"]), new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()]);
  return { id, token, subject, workspaceId };
}
