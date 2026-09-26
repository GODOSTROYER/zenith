/**
 * The workspace sharing RPC against real PostgreSQL, including two independent
 * sessions contending for the workspace lock. Requires migration 0008 and the
 * explicit ZENITH_CONTRACT_POSTGRES=1 / SUPABASE_DB_URL contract-test opt-in.
 * Fixtures have a per-run namespace; cleanup never touches other workspaces.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.ZENITH_CONTRACT_POSTGRES === "1" && Boolean(process.env.SUPABASE_DB_URL);
const prefix = `contract-sharing-${randomUUID()}`;
const id = (label: string) => `${prefix}-${label}-${randomUUID()}`;
const signature = "public.zenith_workspace_sharing(text,text,text,text,text,text,text,text,text,text)";

if (!enabled) {
  console.log(
    "[workspace-sharing pg-contract] skipped: set ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL. " +
      "Workspace locking, invitation uniqueness and database privileges were not verified."
  );
}

type Db = postgres.Sql | postgres.TransactionSql;
type Role = "admin" | "editor" | "viewer";
type Identity = { id: string; email: string; name: string };
type SharingResult = {
  workspace?: { id: string; owner_id: string | null };
  member?: { id: string; role: Role; email: string; workspace_id: string };
  invite?: {
    id: string;
    role: Role;
    email: string;
    accepted_at: string | null;
    revoked_at: string | null;
    expires_at: string | null;
  };
  removed?: unknown;
};
type Operation = {
  operation: "change-role" | "remove-member" | "leave" | "transfer" | "invite" | "revoke" | "resend" | "accept";
  workspace: string;
  actor: Identity;
  member?: string;
  role?: Role;
  invite?: string;
  email?: string;
  newInvite?: string;
};
type Outcome = { ok: true; value: SharingResult } | { ok: false; error: unknown };

let sql: postgres.Sql;
let alpha: postgres.Sql;
let beta: postgres.Sql;

const identity = (label: string): Identity => {
  const userId = id(label);
  return { id: userId, email: `${userId}@contract.invalid`, name: label };
};

async function rpc(db: Db, op: Operation): Promise<SharingResult> {
  const rows = await db<{ result: SharingResult }[]>`
    select public.zenith_workspace_sharing(
      ${op.operation}, ${op.workspace}, ${op.actor.id}, ${op.actor.email}, ${op.actor.name},
      ${op.member ?? null}, ${op.role ?? null}, ${op.invite ?? null},
      ${op.email ?? null}, ${op.newInvite ?? null}
    ) as result
  `;
  return rows[0].result;
}

async function fixture() {
  const workspace = id("workspace");
  const owner = identity("owner");
  const admin = identity("admin");
  const editor = identity("editor");
  const viewer = identity("viewer");
  await sql`
    insert into public.workspaces (id, workspace_id, slug, name, owner_id)
    values (${workspace}, ${workspace}, ${workspace}, 'Sharing contract', ${owner.id})
  `;
  for (const [user, role] of [[owner, "admin"], [admin, "admin"], [editor, "editor"], [viewer, "viewer"]] as const) {
    await sql`
      insert into public.members (id, workspace_id, email, role, data)
      values (${user.id}, ${workspace}, ${user.email}, ${role}, ${sql.json({ name: user.name })})
    `;
  }
  return { workspace, owner, admin, editor, viewer };
}

async function invite(workspace: string, actor: Identity, email: string, role: Role = "editor") {
  const result = await rpc(sql, { operation: "invite", workspace, actor, email, role, newInvite: id("invite") });
  expect(result.invite).toBeDefined();
  return result.invite!;
}

async function member(workspace: string, userId: string) {
  const rows = await sql<{ id: string; role: Role; email: string }[]>`
    select id, role, email from public.members where workspace_id = ${workspace} and id = ${userId}
  `;
  return rows[0];
}

async function ownerId(workspace: string) {
  const rows = await sql<{ owner_id: string | null }[]>`
    select owner_id from public.workspaces where id = ${workspace}
  `;
  return rows[0].owner_id;
}

/**
 * A has changed the rows but holds its transaction open. B starts on another
 * connection. Observe B waiting in PostgreSQL before committing A, then check
 * B's decision against the now-current state. This cannot pass by accidentally
 * running both requests sequentially through a single connection pool.
 */
async function contend(first: Operation, second: Operation): Promise<Outcome> {
  let pending: Promise<Outcome> | undefined;
  try {
    await alpha.begin(async (tx) => {
      await rpc(tx, first);
      let waitingPid: number | undefined;
      pending = beta.begin(async (other) => {
        // Keep the PID read and RPC inside one transaction: Supavisor may
        // assign different PostgreSQL backends between transactions.
        const [{ pid }] = await other<{ pid: number }[]>`select pg_backend_pid() as pid`;
        waitingPid = pid;
        return rpc(other, second);
      }).then(
        (value): Outcome => ({ ok: true, value }),
        (error: unknown): Outcome => ({ ok: false, error })
      );
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (waitingPid !== undefined) {
          const rows = await sql<{ waiting: boolean }[]>`
            select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = ${waitingPid}
          `;
          if (rows[0]?.waiting) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("The competing sharing request never waited for the workspace transaction lock.");
    });
    if (!pending) throw new Error("The competing request was not started.");
    return await pending;
  } finally {
    // A failed assertion still releases A's transaction and drains B before
    // cleanup, avoiding leaked writes arriving after the fixture is deleted.
    if (pending) await pending;
  }
}

function expectRefusal(outcome: Outcome, code: string) {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("The competing request unexpectedly succeeded.");
  expect(outcome.error).toMatchObject({ code });
}

describe.skipIf(!enabled)("WorkspaceSharingPostgres", () => {
  beforeAll(async () => {
    const connect = () => postgres(process.env.SUPABASE_DB_URL!, {
      max: 1,
      prepare: false,
      connect_timeout: 10,
      idle_timeout: 20,
      onnotice: () => {},
    });
    sql = connect();
    alpha = connect();
    beta = connect();
    const rows = await sql<{ present: boolean }[]>`
      select to_regprocedure(${signature}) is not null as present
    `;
    expect(rows[0].present, "Apply supabase/migrations/0008_workspace_ownership.sql before this suite.").toBe(true);
  });

  afterAll(async () => {
    if (!sql) return;
    try {
      for (const table of ["audit_events", "invites", "members", "workspace_versions", "workspaces"]) {
        const column = table === "workspaces" ? "id" : "workspace_id";
        await sql.unsafe(`delete from public.${table} where ${column} like $1`, [`${prefix}%`]);
      }
    } finally {
      await Promise.all([sql, alpha, beta].filter(Boolean).map((client) => client.end({ timeout: 5 })));
    }
  });

  it("grants execute only to the service role, excluding PUBLIC, anon and authenticated", async () => {
    const rows = await sql<{ role: string; allowed: boolean }[]>`
      select r.rolname as role, has_function_privilege(r.oid, ${signature}, 'EXECUTE') as allowed
        from pg_roles r where r.rolname in ('service_role', 'anon', 'authenticated')
    `;
    expect(rows).toEqual(expect.arrayContaining([
      { role: "service_role", allowed: true },
      { role: "anon", allowed: false },
      { role: "authenticated", allowed: false },
    ]));
    const publicGrants = await sql`
      select acl.privilege_type from pg_proc p,
        lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
       where p.oid = to_regprocedure(${signature}) and acl.grantee = 0
    `;
    expect(publicGrants).toHaveLength(0);
    const f = await fixture();
    for (const role of ["anon", "authenticated"] as const) {
      await expect(sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        return rpc(tx, { operation: "leave", workspace: f.workspace, actor: f.editor });
      })).rejects.toMatchObject({ code: "42501" });
    }
    expect(await member(f.workspace, f.editor.id)).toBeDefined();
    await sql.begin(async (tx) => {
      await tx`set local role service_role`;
      await rpc(tx, { operation: "leave", workspace: f.workspace, actor: f.editor });
    });
    expect(await member(f.workspace, f.editor.id)).toBeUndefined();
  });

  it("keeps the owner present and administrative until ownership is transferred", async () => {
    const f = await fixture();
    for (const operation of ["leave", "change-role", "remove-member"] as const) {
      await expect(rpc(sql, {
        operation, workspace: f.workspace, actor: f.owner, member: f.owner.id, role: "viewer",
      })).rejects.toMatchObject({ code: "PT409" });
    }
    expect(await ownerId(f.workspace)).toBe(f.owner.id);
    expect(await member(f.workspace, f.owner.id)).toMatchObject({ role: "admin" });
  });

  it("requires the owner for granting or managing admin access and transferring ownership", async () => {
    const f = await fixture();
    const attempts: Operation[] = [
      { operation: "change-role", workspace: f.workspace, actor: f.admin, member: f.editor.id, role: "admin" },
      { operation: "change-role", workspace: f.workspace, actor: f.admin, member: f.admin.id, role: "viewer" },
      { operation: "remove-member", workspace: f.workspace, actor: f.admin, member: f.admin.id },
      { operation: "transfer", workspace: f.workspace, actor: f.admin, member: f.editor.id },
      { operation: "invite", workspace: f.workspace, actor: f.admin, email: identity("recipient").email, role: "admin", newInvite: id("invite") },
    ];
    for (const attempt of attempts) {
      await expect(rpc(sql, attempt)).rejects.toMatchObject({ code: "PT403" });
    }
    expect(await ownerId(f.workspace)).toBe(f.owner.id);
    expect(await member(f.workspace, f.editor.id)).toMatchObject({ role: "editor" });
  });

  it("uses actor identity rather than a claimed member email to authorize sharing", async () => {
    const f = await fixture();
    await sql`update public.members set email = ${f.owner.email.toUpperCase()}
      where workspace_id = ${f.workspace} and id = ${f.owner.id}`;
    const normalized = await sql<{ email_normalized: string }[]>`
      select email_normalized from public.members where workspace_id = ${f.workspace} and id = ${f.owner.id}
    `;
    expect(normalized[0].email_normalized).toBe(f.owner.email);
    const stranger = { ...identity("stranger"), email: f.owner.email };
    for (const actor of [stranger, f.viewer, f.editor]) {
      await expect(rpc(sql, {
        operation: "change-role", workspace: f.workspace, actor, member: f.viewer.id, role: "editor",
      })).rejects.toMatchObject({ code: "PT403" });
    }
    expect(await member(f.workspace, f.viewer.id)).toMatchObject({ role: "viewer" });
  });

  it("allows admins to manage non-admin collaborators and lets non-owners leave", async () => {
    const f = await fixture();
    const changed = await rpc(sql, {
      operation: "change-role", workspace: f.workspace, actor: f.admin, member: f.viewer.id, role: "editor",
    });
    expect(changed.member).toMatchObject({ id: f.viewer.id, role: "editor" });
    await rpc(sql, { operation: "remove-member", workspace: f.workspace, actor: f.admin, member: f.editor.id });
    await rpc(sql, { operation: "leave", workspace: f.workspace, actor: f.viewer });
    expect(await member(f.workspace, f.editor.id)).toBeUndefined();
    expect(await member(f.workspace, f.viewer.id)).toBeUndefined();
    expect(await ownerId(f.workspace)).toBe(f.owner.id);
  });

  it("rechecks a competing remover's authority after the owner demotes that admin", async () => {
    const f = await fixture();
    const result = await contend(
      { operation: "change-role", workspace: f.workspace, actor: f.owner, member: f.admin.id, role: "viewer" },
      { operation: "remove-member", workspace: f.workspace, actor: f.admin, member: f.editor.id }
    );
    expectRefusal(result, "PT403");
    expect(await member(f.workspace, f.admin.id)).toMatchObject({ role: "viewer" });
    expect(await member(f.workspace, f.editor.id)).toBeDefined();
  });

  it("rechecks a competing role change after the owner removes the acting admin", async () => {
    const f = await fixture();
    const result = await contend(
      { operation: "remove-member", workspace: f.workspace, actor: f.owner, member: f.admin.id },
      { operation: "change-role", workspace: f.workspace, actor: f.admin, member: f.editor.id, role: "viewer" }
    );
    expectRefusal(result, "PT403");
    expect(await member(f.workspace, f.admin.id)).toBeUndefined();
    expect(await member(f.workspace, f.editor.id)).toMatchObject({ role: "editor" });
  });

  it("protects the newly transferred owner against a competing removal", async () => {
    const f = await fixture();
    const result = await contend(
      { operation: "transfer", workspace: f.workspace, actor: f.owner, member: f.editor.id },
      { operation: "remove-member", workspace: f.workspace, actor: f.owner, member: f.editor.id }
    );
    expect(result.ok).toBe(false);
    expect(await ownerId(f.workspace)).toBe(f.editor.id);
    expect(await member(f.workspace, f.editor.id)).toMatchObject({ role: "admin" });
    expect(await member(f.workspace, f.owner.id)).toMatchObject({ role: "admin" });
    await rpc(sql, { operation: "leave", workspace: f.workspace, actor: f.owner });
    expect(await member(f.workspace, f.owner.id)).toBeUndefined();
  });

  it("refuses a second ownership transfer from the former owner after waiting for the first", async () => {
    const f = await fixture();
    const result = await contend(
      { operation: "transfer", workspace: f.workspace, actor: f.owner, member: f.editor.id },
      { operation: "transfer", workspace: f.workspace, actor: f.owner, member: f.viewer.id }
    );
    expectRefusal(result, "PT403");
    expect(await ownerId(f.workspace)).toBe(f.editor.id);
    expect(await member(f.workspace, f.editor.id)).toMatchObject({ role: "admin" });
    expect(await member(f.workspace, f.viewer.id)).toMatchObject({ role: "viewer" });
  });

  it("accepts a normalized matching email while refusing another signed-in identity's email", async () => {
    const f = await fixture();
    const recipient = identity("recipient");
    const invitation = await invite(f.workspace, f.owner, recipient.email.toUpperCase(), "viewer");
    await expect(rpc(sql, {
      operation: "accept", workspace: f.workspace, actor: identity("wrong-email"), invite: invitation.id,
    })).rejects.toMatchObject({ code: "PT403" });
    expect(await member(f.workspace, recipient.id)).toBeUndefined();
    const accepted = await rpc(sql, {
      operation: "accept", workspace: f.workspace, actor: { ...recipient, email: ` ${recipient.email.toUpperCase()} ` },
      invite: invitation.id, role: "admin",
    });
    expect(accepted.member).toMatchObject({ id: recipient.id, workspace_id: f.workspace, role: "viewer" });
    expect(await member(f.workspace, recipient.id)).toMatchObject({ role: "viewer" });
    const rows = await sql<{ accepted_at: Date | null }[]>`select accepted_at from public.invites where id = ${invitation.id}`;
    expect(rows[0].accepted_at).not.toBeNull();
  });

  it("rejects a revoked invitation even when a caller retained its former live state", async () => {
    const f = await fixture();
    const recipient = identity("recipient");
    const invitation = await invite(f.workspace, f.owner, recipient.email);
    await rpc(sql, { operation: "revoke", workspace: f.workspace, actor: f.owner, invite: invitation.id });
    await expect(rpc(sql, {
      operation: "accept", workspace: f.workspace, actor: recipient, invite: invitation.id,
    })).rejects.toMatchObject({ code: "PT410" });
    expect(await member(f.workspace, recipient.id)).toBeUndefined();
  });

  it("rechecks invitation revocation after a competing accept waits for the workspace lock", async () => {
    const f = await fixture();
    const recipient = identity("recipient");
    const invitation = await invite(f.workspace, f.owner, recipient.email);
    const result = await contend(
      { operation: "revoke", workspace: f.workspace, actor: f.owner, invite: invitation.id },
      { operation: "accept", workspace: f.workspace, actor: recipient, invite: invitation.id }
    );
    expectRefusal(result, "PT410");
    expect(await member(f.workspace, recipient.id)).toBeUndefined();
  });

  it("renews an expired invitation on resend, while refusing to renew a revoked offer", async () => {
    const f = await fixture();
    const recipient = identity("recipient");
    const invitation = await invite(f.workspace, f.owner, recipient.email);
    await sql`update public.invites set expires_at = now() - interval '1 minute' where id = ${invitation.id}`;
    const resent = await rpc(sql, {
      operation: "resend", workspace: f.workspace, actor: f.owner, invite: invitation.id,
    });
    expect(resent.invite).toMatchObject({ id: invitation.id, email: recipient.email, role: "editor" });
    expect(Date.parse(resent.invite!.expires_at!)).toBeGreaterThan(Date.now());
    await rpc(sql, { operation: "accept", workspace: f.workspace, actor: recipient, invite: invitation.id });
    expect(await member(f.workspace, recipient.id)).toMatchObject({ role: "editor" });
    const revoked = await invite(f.workspace, f.owner, identity("revoked-recipient").email);
    await rpc(sql, { operation: "revoke", workspace: f.workspace, actor: f.owner, invite: revoked.id });
    await expect(rpc(sql, {
      operation: "resend", workspace: f.workspace, actor: f.owner, invite: revoked.id,
    })).rejects.toMatchObject({ code: "PT410" });
  });

  it("refuses expired invitations without creating membership", async () => {
    const f = await fixture();
    const recipient = identity("recipient");
    const invitation = await invite(f.workspace, f.owner, recipient.email);
    await sql`update public.invites set expires_at = now() - interval '1 minute' where id = ${invitation.id}`;
    await expect(rpc(sql, {
      operation: "accept", workspace: f.workspace, actor: recipient, invite: invitation.id,
    })).rejects.toMatchObject({ code: "PT410" });
    expect(await member(f.workspace, recipient.id)).toBeUndefined();
  });

  it("does not restore access when an accepted invitation is replayed after removal", async () => {
    const f = await fixture();
    const recipient = identity("recipient");
    const invitation = await invite(f.workspace, f.owner, recipient.email, "admin");
    const accept: Operation = { operation: "accept", workspace: f.workspace, actor: recipient, invite: invitation.id };
    await rpc(sql, accept);
    await rpc(sql, {
      operation: "change-role", workspace: f.workspace, actor: f.owner, member: recipient.id, role: "viewer",
    });
    const replay = await rpc(sql, accept);
    expect(replay.member).toMatchObject({ id: recipient.id, role: "viewer" });
    await rpc(sql, { operation: "remove-member", workspace: f.workspace, actor: f.owner, member: recipient.id });
    await expect(rpc(sql, accept)).rejects.toMatchObject({ code: "PT410" });
    expect(await member(f.workspace, recipient.id)).toBeUndefined();
  });

  it("preserves an existing member's role when accepting an older admin invitation", async () => {
    const f = await fixture();
    const recipient = identity("recipient");
    const invitation = await invite(f.workspace, f.owner, recipient.email, "admin");
    await sql`
      insert into public.members (id, workspace_id, email, role)
      values (${recipient.id}, ${f.workspace}, ${recipient.email}, 'viewer')
    `;
    const accepted = await rpc(sql, {
      operation: "accept", workspace: f.workspace, actor: recipient, invite: invitation.id,
    });
    expect(accepted.member).toMatchObject({ id: recipient.id, role: "viewer" });
    expect(await member(f.workspace, recipient.id)).toMatchObject({ role: "viewer" });
  });

  it.each(["remove-member", "leave"] as const)("revokes old pending offers when a member exits through %s", async (operation) => {
    const f = await fixture();
    const recipient = identity("recipient");
    const invitation = await invite(f.workspace, f.owner, recipient.email, "admin");
    await sql`
      insert into public.members (id, workspace_id, email, role)
      values (${recipient.id}, ${f.workspace}, ${recipient.email}, 'viewer')
    `;
    await rpc(sql, {
      operation, workspace: f.workspace, actor: operation === "leave" ? recipient : f.owner, member: recipient.id,
    });
    await expect(rpc(sql, {
      operation: "accept", workspace: f.workspace, actor: recipient, invite: invitation.id,
    })).rejects.toMatchObject({ code: "PT410" });
    expect(await member(f.workspace, recipient.id)).toBeUndefined();
    const rows = await sql<{ revoked_at: Date | null }[]>`select revoked_at from public.invites where id = ${invitation.id}`;
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it("commits an audit event with a role change and writes no event for a refused mutation", async () => {
    const f = await fixture();
    await rpc(sql, {
      operation: "change-role", workspace: f.workspace, actor: f.owner, member: f.editor.id, role: "viewer",
    });
    const events = await sql<{ action_id: string }[]>`
      select action_id from public.audit_events where workspace_id = ${f.workspace}
    `;
    expect(events).toHaveLength(1);
    expect(events[0].action_id).toBe("workspace.change-role");
    await expect(rpc(sql, {
      operation: "change-role", workspace: f.workspace, actor: f.viewer, member: f.editor.id, role: "admin",
    })).rejects.toMatchObject({ code: "PT403" });
    const after = await sql`select id from public.audit_events where workspace_id = ${f.workspace}`;
    expect(after).toHaveLength(1);
  });

  it("lets a fresh invitation replace an expired pending offer without reviving the old one", async () => {
    const f = await fixture();
    const recipient = identity("recipient");
    const expired = await invite(f.workspace, f.owner, recipient.email);
    await sql`update public.invites set expires_at = now() - interval '1 minute' where id = ${expired.id}`;
    const fresh = await invite(f.workspace, f.owner, recipient.email, "viewer");
    await expect(rpc(sql, {
      operation: "accept", workspace: f.workspace, actor: recipient, invite: expired.id,
    })).rejects.toMatchObject({ code: "PT410" });
    await rpc(sql, { operation: "accept", workspace: f.workspace, actor: recipient, invite: fresh.id });
    expect(await member(f.workspace, recipient.id)).toMatchObject({ role: "viewer" });
  });

  it("allows one pending invitation per normalized address and workspace under competing requests", async () => {
    const f = await fixture();
    const recipient = identity("recipient");
    const operations = [recipient.email, recipient.email.toUpperCase()].map((email): Operation => ({
      operation: "invite", workspace: f.workspace, actor: f.owner, email, role: "editor", newInvite: id("invite"),
    }));
    const outcomes = await Promise.allSettled([rpc(alpha, operations[0]), rpc(beta, operations[1])]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rows = await sql<{ id: string }[]>`
      select id from public.invites where workspace_id = ${f.workspace}
        and lower(btrim(email)) = ${recipient.email} and accepted_at is null and revoked_at is null
    `;
    expect(rows).toHaveLength(1);
    await expect(sql`
      insert into public.invites (id, workspace_id, email, role, expires_at)
      values (${id("duplicate")}, ${f.workspace}, ${recipient.email.toUpperCase()}, 'viewer', now() + interval '1 day')
    `).rejects.toMatchObject({ code: "23505" });
    await rpc(sql, { operation: "revoke", workspace: f.workspace, actor: f.owner, invite: rows[0].id });
    const replacement = await invite(f.workspace, f.owner, recipient.email);
    expect(replacement.id).not.toBe(rows[0].id);
  });

  it("cannot use an invitation or membership id from a different workspace", async () => {
    const a = await fixture();
    const b = await fixture();
    const recipient = identity("recipient");
    const invitation = await invite(a.workspace, a.owner, recipient.email);
    await expect(rpc(sql, {
      operation: "accept", workspace: b.workspace, actor: recipient, invite: invitation.id,
    })).rejects.toMatchObject({ code: "PT404" });
    await expect(rpc(sql, {
      operation: "change-role", workspace: b.workspace, actor: b.owner, member: a.editor.id, role: "viewer",
    })).rejects.toMatchObject({ code: "PT404" });
    expect(await member(a.workspace, a.editor.id)).toMatchObject({ role: "editor" });
    expect(await member(a.workspace, recipient.id)).toBeUndefined();
    expect(await member(b.workspace, recipient.id)).toBeUndefined();
  });
});
