import type { Sql } from "@/lib/controlplane/types";
import { GithubSourceError, identifier } from "./types";
import { normalizeInspectionRoot } from "./inspect";
import { append } from "@/lib/controlplane/db/repos/events";

export interface ProjectRepositorySource {
  projectId: string; bindingId: string; repositoryId: number; repository: string;
  ref: string; root: string; contextDir: string; version: number; revoked: boolean;
}
interface Row {
  project_id: string; binding_id: string; repository_id: number | string; owner: string; repo: string;
  ref: string; root: string; context_dir: string; version: number; detached_at: unknown; revoked_at: unknown;
}
const project = (row: Row): ProjectRepositorySource => ({
  projectId: row.project_id, bindingId: row.binding_id, repositoryId: Number(row.repository_id),
  repository: row.owner + "/" + row.repo, ref: row.ref, root: row.root, contextDir: row.context_dir,
  version: Number(row.version), revoked: row.revoked_at != null,
});
export async function getProjectRepository(sql: Sql, workspaceId: string, projectId: string): Promise<{ source: ProjectRepositorySource | null; version: number }> {
  const rows = await sql.query<Row>(
    "select p.*,b.repository_id,b.owner,b.repo,b.revoked_at from platform.github_project_sources p join platform.github_source_bindings b on b.workspace_id=p.workspace_id and b.binding_id=p.binding_id where p.workspace_id=$1 and p.project_id=$2",
    [identifier(workspaceId), identifier(projectId)],
  );
  return { source: rows[0] && rows[0].detached_at == null ? project(rows[0]) : null, version: Number(rows[0]?.version ?? 0) };
}

export type ProjectSourceChange = { projectId: string; expectedVersion: number } & (
  { detach: true } | { bindingId: string; ref: string; root?: string; contextDir?: string; detach?: false }
);
/** Project ownership and current human authority are checked by the caller, again after lock waits. */
export async function changeProjectRepository(sql: Sql, workspaceId: string, actorId: string, input: ProjectSourceChange, authorize: () => Promise<void>) {
  const ws = identifier(workspaceId), pid = identifier(input.projectId);
  return sql.tx(async tx => {
    if (!input.detach) {
      const bindings = await tx.query<{ binding_id: string; revoked_at: unknown }>(
        "select binding_id,revoked_at from platform.github_source_bindings where workspace_id=$1 and binding_id=$2 for update",
        [ws, identifier(input.bindingId)],
      );
      if (bindings.length !== 1 || bindings[0].revoked_at != null) throw new GithubSourceError("refused", "Select a current repository connection.");
    }
    const [existing] = await tx.query<{ version: number }>("select version from platform.github_project_sources where workspace_id=$1 and project_id=$2 for update", [ws, pid]);
    await authorize();
    if (Number(existing?.version ?? 0) !== input.expectedVersion) throw new GithubSourceError("conflict");
    if (input.detach) {
      if (!existing) throw new GithubSourceError("conflict");
      await tx.query("update platform.github_project_sources set detached_at=clock_timestamp(),version=version+1,updated_by=$3,updated_at=clock_timestamp() where workspace_id=$1 and project_id=$2", [ws, pid, identifier(actorId)]);
    } else {
      if (!/^[A-Za-z0-9._+@/-]{1,250}$/.test(input.ref) || input.ref.includes("..") || input.ref.startsWith("/") || input.ref.endsWith("/") || input.ref.includes("//")) throw new GithubSourceError("invalid");
      const root = normalizeInspectionRoot(input.root), context = normalizeInspectionRoot(input.contextDir);
      const values = [ws, pid, identifier(input.bindingId), input.ref, root, context, identifier(actorId)];
      if (existing) await tx.query("update platform.github_project_sources set binding_id=$3,ref=$4,root=$5,context_dir=$6,updated_by=$7,version=version+1,detached_at=null,updated_at=clock_timestamp() where workspace_id=$1 and project_id=$2", values);
      else {
        const inserted = await tx.query("insert into platform.github_project_sources(workspace_id,project_id,binding_id,ref,root,context_dir,updated_by) values($1,$2,$3,$4,$5,$6,$7) on conflict(workspace_id,project_id) do nothing returning project_id", values);
        if (inserted.length !== 1) throw new GithubSourceError("conflict");
      }
    }
    await append(tx, {
      type: input.detach ? "project.repository_detached" : "project.repository_attached",
      workspaceId: ws, projectId: pid, correlationId: `project-repository:${pid}:${input.expectedVersion + 1}`,
      actor: { kind: "user", id: identifier(actorId), name: identifier(actorId) },
      data: { version: input.expectedVersion + 1, ...(!input.detach ? { bindingId: input.bindingId } : {}) },
    });
    return getProjectRepository(tx, ws, pid);
  });
}
