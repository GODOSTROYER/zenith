"use client";
/**
 * Members — the screen every role refusal in the product points at.
 *
 * Roles are the member record; the API enforces them and protects the last
 * admin in both directions. What this screen adds is honesty about the two
 * places membership leaks: an operator-set Supabase claim outranks anything
 * changed here, and Zenith.ai sends no mail, so an invite is a permission, not a
 * message.
 */
import { useState } from "react";
import { Trash2, UserPlus } from "lucide-react";
import { api, useJson } from "@/lib/client/api";
import type { Invite, Member } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeAgo } from "@/components/ui/time-ago";
import { ErrorNote, errorText, useSafeToasts } from "@/components/screens/shared";
import type { Bootstrap } from "@/components/shell/shell-context";

const ROLE_OPTIONS = [
  { value: "admin", label: "admin — everything, including members, budgets, policies and connections" },
  { value: "editor", label: "editor — edit the system and start deploys" },
  { value: "viewer", label: "viewer — read everything, preview anything, run nothing" },
];

/** Short form for the read-only list. */
const ROLE_WHAT: Record<Member["role"], string> = {
  admin: "members, budgets, policies, connections, deletes",
  editor: "edits the system and starts deploys",
  viewer: "reads everything, changes nothing",
};

/**
 * The removal caveat, stated wherever removal is offered. `ensureMember`
 * re-applies `app_metadata.role` on authenticated requests, so an operator claim
 * outranks this list.
 */
const READMIT_NOTE =
  "Removing someone here does not clear a Supabase app_metadata.role claim. A valid claim can add them back with that role on their next authenticated request, without another sign-in. Resolve the operator claim in Supabase before relying on removal to block access.";

const SESSION_NOTE =
  "Removing membership does not end their existing session or close an open page. Their next request to this workspace is refused unless a role claim or another membership rule admits them again.";

export function MembersSection({
  boot,
  refresh,
}: {
  boot: Bootstrap | undefined;
  refresh: () => void;
}) {
  const toasts = useSafeToasts();
  const admin = boot?.role === "admin";
  const invites = useJson<{ invites: Invite[] }>(admin ? "/api/workspace/invites" : null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);

  if (!boot) return <Skeleton height={220} />;

  const members = boot.members;
  const admins = members.filter((m) => m.role === "admin");
  const open = (invites.data?.invites ?? []).filter((i) => !i.acceptedAt);

  /**
   * One call site for every membership mutation: toast the fix, then reload.
   * Returns whether it worked, so a form can keep what was typed when it did
   * not (the API refuses duplicates and the last admin, and both are fixable).
   */
  const call = async (id: string, run: () => Promise<unknown>, ok: string): Promise<boolean> => {
    setBusyId(id);
    try {
      await run();
      toasts.push({ kind: "ok", title: ok });
      refresh();
      invites.refresh();
      return true;
    } catch (e) {
      const { message, fix } = errorText(e);
      toasts.push({ kind: "err", title: message, body: fix });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const setRole = (m: Member, role: string) =>
    call(
      m.id,
      () =>
        api(`/api/workspace/members/${m.id}`, {
          method: "PATCH",
          body: JSON.stringify({ role }),
        }),
      `${m.name} is now ${role} in ${boot.workspace.name}.`
    );

  const remove = async (m: Member) => {
    const ok = await call(
      m.id,
      () => api(`/api/workspace/members/${m.id}`, { method: "DELETE" }),
      `Removed ${m.name} from ${boot.workspace.name}.`
    );
    if (ok) setRemoving(null);
  };

  const revoke = (i: Invite) =>
    call(i.id, () => api(`/api/workspace/invites/${i.id}`, { method: "DELETE" }), `Revoked the invite for ${i.email}.`);

  return (
    <div className="space-y-4">
      {!admin && (
        <Card>
          <p className="text-[13px] text-ink">
            You are {boot.role ?? "signed out"} in {boot.workspace.name}, so this list is read-only.
          </p>
          <p className="mt-1.5 max-w-[70ch] text-[12.5px] text-ink-mute">
            {admins.length
              ? `Changing roles and inviting people needs the admin role. Ask ${admins
                  .map((a) => `${a.name} (${a.email})`)
                  .join(" or ")}.`
              : "This workspace has no admin, so nobody can change roles from here. An operator can grant one by setting app_metadata.role on a Supabase user (see scripts/seed-users.ts)."}
          </p>
        </Card>
      )}

      <Card
        title={`${members.length} member${members.length === 1 ? "" : "s"}`}
        subtitle="Roles are enforced on every action, not just hidden in the UI. Planning stays open to everyone: any member can preview what an action would do."
        padded={false}
      >
        <ul>
          {members.map((m) => {
            const you = boot.user?.id === m.id;
            // The API refuses to leave the workspace without an admin. Say so
            // here rather than after the click.
            const last = m.role === "admin" && admins.length === 1;
            const lastReason = `${m.name} is the last admin of ${boot.workspace.name}. Make someone else an admin first — a workspace with no admin can never change roles, budgets or connections again.`;
            return (
              <li
                key={m.id}
                className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-ink">
                    {m.name}
                    {you && <span className="ml-2 text-[12px] text-ink-faint">you</span>}
                  </p>
                  <p className="truncate font-mono text-[12px] text-ink-mute">{m.email}</p>
                </div>

                {admin ? (
                  <div className="w-[190px] shrink-0">
                    <Select
                      value={m.role}
                      aria-label={`Role for ${m.name}`}
                      disabled={busyId === m.id || last}
                      title={last ? lastReason : undefined}
                      onChange={(e) => setRole(m, e.target.value)}
                      options={ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.value }))}
                    />
                  </div>
                ) : (
                  <Chip tone={m.role === "admin" ? "signal" : "neutral"}>{m.role}</Chip>
                )}

                <span className="hidden w-[240px] shrink-0 text-[12px] text-ink-faint lg:block">
                  {ROLE_WHAT[m.role]}
                </span>

                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  disabled={!admin || last}
                  disabledReason={
                    admin ? lastReason : "Removing a member needs the admin role."
                  }
                  onClick={() => setRemoving(m)}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-line px-5 py-3">
          <p className="max-w-[80ch] text-[12px] text-ink-faint">{READMIT_NOTE}</p>
        </div>
      </Card>

      {admin && (
        <>
          <InviteForm
            workspaceName={boot.workspace.name}
            busy={busyId === "invite"}
            onInvite={(email, role) =>
              call(
                "invite",
                () =>
                  api("/api/workspace/invites", {
                    method: "POST",
                    body: JSON.stringify({ email, role }),
                  }),
                `Invite recorded for ${email} to join ${boot.workspace.name} as ${role}.`
              )
            }
          />

          <Card
            title={`Pending invites (${open.length})`}
            subtitle="An invite lets this email join with the listed role unless an operator role claim overrides it. Zenith.ai sends no mail — share the sign-in link yourself."
            padded={false}
          >
            {invites.error ? (
              <div className="p-5">
                <ErrorNote error={invites.error} />
              </div>
            ) : open.length === 0 ? (
              <p className="px-5 py-4 text-[13px] text-ink-mute">
                No open invites. Users with an operator role claim can still join this workspace.
              </p>
            ) : (
              <ul>
                {open.map((i) => (
                  <li
                    key={i.id}
                    className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
                      {i.email}
                    </span>
                    <Chip tone="neutral">{i.role}</Chip>
                    <span className="text-[12px] text-ink-faint">
                      <TimeAgo iso={i.createdAt} prefix="invited" />
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={busyId === i.id}
                      onClick={() => revoke(i)}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove ${removing.name} from ${boot.workspace.name}` : ""}
        tone="danger"
        width={520}
        footer={
          <>
            <Button variant="quiet" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              busy={busyId === removing?.id}
              onClick={() => removing && remove(removing)}
            >
              Remove member
            </Button>
          </>
        }
      >
        {removing && (
          <ul className="space-y-2 text-[13px] text-ink-mute">
            <li>
              This removes {removing.name}&rsquo;s ({removing.email}) {removing.role} membership from{" "}
              {boot.workspace.name}. Nothing they created is deleted, and the audit trail keeps
              every row with their name on it.
            </li>
            <li>{SESSION_NOTE}</li>
            <li>{READMIT_NOTE}</li>
            {boot.user?.id === removing.id && (
              <li className="text-warn">
                This is you. Your next workspace request will be refused unless a role claim or another membership rule admits you again.
              </li>
            )}
            <li>Re-inviting the same address lets them join again on an authenticated request.</li>
          </ul>
        )}
      </Dialog>
    </div>
  );
}

function InviteForm({
  workspaceName,
  busy,
  onInvite,
}: {
  workspaceName: string;
  busy: boolean;
  /** resolves false when the invite was refused, so the text survives */
  onInvite: (email: string, role: string) => Promise<boolean>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const trimmed = email.trim();
  const valid = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(trimmed);

  return (
    <Card
      title="Invite someone"
      subtitle={`New members need an invite or an operator role claim to join ${workspaceName}.`}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_240px]">
        <Field label="Email" help="Matched against the address they sign in with, case-insensitively.">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@example.com"
            type="email"
            autoComplete="off"
          />
        </Field>
        <Field label="Role" help="An operator role claim overrides this choice and later changes in the member list.">
          <Select value={role} onChange={(e) => setRole(e.target.value)} options={ROLE_OPTIONS} />
        </Field>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button
          icon={<UserPlus className="h-3.5 w-3.5" />}
          busy={busy}
          disabled={!valid}
          disabledReason={
            trimmed ? "That does not look like an email address." : "Enter an email address."
          }
          onClick={async () => {
            if (await onInvite(trimmed.toLowerCase(), role)) setEmail("");
          }}
        >
          Invite
        </Button>
        <p className="text-[12px] text-ink-faint">
          No email is sent. Send them the sign-in link yourself.
        </p>
      </div>
    </Card>
  );
}
