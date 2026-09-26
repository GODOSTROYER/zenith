"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, LockKeyhole, UserPlus } from "lucide-react";
import { api, useJson } from "@/lib/client/api";
import type { Invite, Member, Workspace } from "@/lib/domain/types";
import type { Bootstrap } from "@/components/shell/shell-context";
import { ErrorNote } from "@/components/screens/action-confirm";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

type Role = Member["role"];
export interface WorkspaceSharingData {
  workspace: Workspace;
  members: Member[];
  invites: Invite[];
  role: Role;
  isOwner: boolean;
  canManageMembers: boolean;
  canManageAdmins: boolean;
}

export const WORKSPACE_ROLES: { value: Role; label: string; description: string }[] = [
  { value: "viewer", label: "Viewer", description: "View the workspace and preview plans. Cannot apply changes." },
  { value: "editor", label: "Editor", description: "Edit projects and start deployments. Cannot manage workspace access." },
  { value: "admin", label: "Admin", description: "Manage settings and invite or manage viewers and editors. The owner manages admins." },
];

type Confirmation =
  | { kind: "role"; member: Member; role: Role }
  | { kind: "remove"; member: Member }
  | { kind: "transfer"; member: Member }
  | { kind: "leave" };

/** Shared by the workspace Share page and existing Settings → Members links. */
export function WorkspaceSharing({ boot, refresh }: { boot: Bootstrap | undefined; refresh: () => void }) {
  if (!boot) return <Skeleton height={240} />;
  // Reset forms and confirmations when the selected workspace changes.
  return <WorkspaceSharingContent key={boot.workspace.id} boot={boot} refresh={refresh} />;
}

function WorkspaceSharingContent({ boot, refresh }: { boot: Bootstrap; refresh: () => void }) {
  const router = useRouter();
  const workspaceId = boot.workspace.id;
  const query = "workspaceId=" + encodeURIComponent(workspaceId);
  const sharing = useJson<WorkspaceSharingData>("/api/workspace/sharing?" + query, 10_000);
  const [busy, setBusy] = useState<string | null>(null);
  const mutating = useRef(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [transferName, setTransferName] = useState("");
  const [transferMember, setTransferMember] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const data = sharing.data?.workspace.id === workspaceId ? sharing.data : undefined;

  async function mutate<T>(key: string, run: () => Promise<T>, message: string): Promise<T | undefined> {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(key);
    setError(undefined);
    setNotice("");
    try {
      const result = await run();
      setNotice(message);
      sharing.refresh();
      refresh();
      return result;
    } catch (cause) {
      setError(cause);
      return undefined;
    } finally { mutating.current = false; setBusy(null); }
  }

  async function copy(path: string) {
    const url = new URL(path, window.location.origin).href;
    setInviteLink(url);
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Link copied. Access still requires an invited email or an existing membership.");
    } catch {
      setNotice("Copy the link from the field below. Your browser could not copy it automatically.");
    }
  }

  if (!data) return sharing.error
    ? <div className="space-y-3"><ErrorNote error={sharing.error} /><Button onClick={sharing.refresh}>Retry loading access</Button></div>
    : <div role="status" aria-label="Loading workspace access"><Skeleton height={240} /></div>;

  const { workspace, members, invites, isOwner, canManageMembers, canManageAdmins } = data;
  const roleOptions = WORKSPACE_ROLES.filter((role) => role.value !== "admin" || canManageAdmins);
  const pendingInvites = invites.filter((invite) => !invite.acceptedAt && !invite.revokedAt);
  const transferable = members.filter((member) => member.id !== workspace.ownerId && member.id !== boot.user?.id && !!member.email && !["you@local", "you@kepler.dev"].includes(member.email.toLowerCase()));
  const owner = members.find((member) => member.id === workspace.ownerId);
  const blocked = !!busy || !!sharing.error;
  const closeConfirmation = () => { if (!busy) { setConfirmation(null); setTransferName(""); } };

  async function confirm() {
    if (!confirmation) return;
    const request = confirmation;
    const message = request.kind === "leave" ? "You left " + workspace.name + "."
      : request.kind === "transfer" ? "Ownership transferred to " + request.member.name + ". You remain an admin."
      : request.kind === "remove" ? request.member.name + " no longer has access to " + workspace.name + "."
      : request.member.name + " now has " + request.role + " access.";
    const result = await mutate("confirmation", () => {
      if (request.kind === "leave") return api("/api/workspace/leave", { method: "POST", body: JSON.stringify({ workspaceId }) });
      if (request.kind === "transfer") return api("/api/workspace/ownership", { method: "POST", body: JSON.stringify({ workspaceId, memberId: request.member.id }) });
      const url = "/api/workspace/members/" + encodeURIComponent(request.member.id) + "?" + query;
      return api(url, request.kind === "remove"
        ? { method: "DELETE" }
        : { method: "PATCH", body: JSON.stringify({ workspaceId, role: request.role }) });
    }, message);
    if (result !== undefined) {
      setConfirmation(null);
      setTransferName("");
      if (request.kind === "leave") {
        router.push(boot.workspaces.length > 1 ? "/overview" : "/onboarding?step=1");
        router.refresh();
      }
    }
  }

  return (
    <div className="space-y-5">
      <Card title="Workspace access" subtitle={"Sharing applies to every project in " + workspace.name + ". Hosted app collaborator roles are managed separately in each app."}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-[65ch] space-y-2 text-sm text-ink-mute">
            <p className="flex items-center gap-2 font-medium text-ink"><LockKeyhole size={16} aria-hidden="true" />Restricted to members and invited people</p>
            <p>You have <strong className="text-ink">{isOwner ? "owner" : data.role}</strong> access. Copying a workspace link does not grant access.</p>
            {!canManageMembers && <p>Ask the workspace owner or an admin to invite people or change access.</p>}
          </div>
          <Button size="sm" icon={<Copy size={14} aria-hidden="true" />} onClick={() => void copy("/workspace?workspace=" + encodeURIComponent(workspaceId))}>Copy workspace link</Button>
        </div>
        <dl className="mt-5 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
          {WORKSPACE_ROLES.map((role) => <div key={role.value}><dt className="text-[13px] font-medium text-ink">{role.label}</dt><dd className="mt-1 text-xs leading-relaxed text-ink-mute">{role.description}</dd></div>)}
        </dl>
      </Card>

      {sharing.error && <div className="space-y-3"><ErrorNote error={sharing.error} /><Button onClick={sharing.refresh}>Retry loading access</Button></div>}
      {!!error && <ErrorNote error={error} />}
      {notice && <p role="status" className="text-sm text-ink">{notice}</p>}
      {inviteLink && <Field label="Link to share" help="The recipient must sign in with their invited email. A workspace link alone never changes access."><Input readOnly value={inviteLink} onFocus={(event) => event.target.select()} /></Field>}

      {canManageMembers && <InviteForm key={canManageAdmins ? "owner" : "admin"} busy={blocked} roles={roleOptions} onInvite={async (email, role) => {
        const result = await mutate("invite", () => api<{ invite: Invite; inviteUrl: string }>("/api/workspace/invites", {
          method: "POST", body: JSON.stringify({ email, role, workspaceId }),
        }), "Invitation created for " + email + ". Share the invite link with them.");
        if (result) setInviteLink(new URL(result.inviteUrl, window.location.origin).href);
        return !!result;
      }} />}

      <Card title={"People with access (" + members.length + ")"} subtitle="The owner controls ownership and admin access. Admins manage viewers and editors." padded={false}>
        {members.length === 0 ? <p className="px-5 py-4 text-sm text-ink-mute">No members were returned. Refresh access before making changes.</p> : <ul>
          {members.map((member) => {
            const memberIsOwner = member.id === workspace.ownerId;
            const canManage = canManageMembers && !memberIsOwner && (member.role !== "admin" || canManageAdmins);
            const you = member.id === boot.user?.id;
            return <li key={member.id} className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4 last:border-0">
              <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium text-ink">{member.name}{you && <span className="ml-2 text-xs text-ink-faint">you</span>}</p><p className="break-all text-xs text-ink-mute">{member.email}</p></div>
              {memberIsOwner ? <Chip tone="signal">Owner</Chip> : canManage ? <div className="w-28"><Select aria-label={"Role for " + member.name} value={member.role} disabled={blocked} options={roleOptions} onChange={(event) => setConfirmation({ kind: "role", member, role: event.target.value as Role })} /></div> : <Chip tone={member.role === "admin" ? "signal" : "neutral"}>{member.role}</Chip>}
              {canManage && !you && <Button variant="ghost" size="sm" disabled={blocked} disabledReason="Wait for the current request to finish or refresh access." aria-label={"Remove " + member.name} onClick={() => setConfirmation({ kind: "remove", member })}>Remove</Button>}
            </li>;
          })}
        </ul>}
      </Card>

      {canManageMembers && <Card title={"Invitations (" + pendingInvites.length + ")"} subtitle="Invites are bound to the listed email and expire after seven days. No invitation email is sent; copy and share the link." padded={false}>
        {pendingInvites.length === 0 ? <p className="px-5 py-4 text-sm text-ink-mute">No pending invitations.</p> : <ul>
          {pendingInvites.map((invite) => {
            const expired = !!invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now();
            const manageable = invite.role !== "admin" || canManageAdmins;
            return <li key={invite.id} className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4 last:border-0">
              <div className="min-w-0 flex-1"><p className="break-all text-sm text-ink">{invite.email}</p><p className="mt-1 text-xs text-ink-faint">{expired ? "Expired" : "Awaiting acceptance"}{invite.expiresAt && <> · {expired ? "Expired" : "Expires"} <time dateTime={invite.expiresAt}>{new Date(invite.expiresAt).toLocaleDateString()}</time></>}</p></div>
              <Chip tone="neutral">{invite.role}</Chip>
              {!expired && <Button size="sm" variant="ghost" onClick={() => void copy("/invite?invite=" + encodeURIComponent(invite.id))} aria-label={"Copy invite for " + invite.email}>Copy link</Button>}
              {manageable && <>
                <Button size="sm" variant="ghost" busy={busy === "renew:" + invite.id} disabled={blocked} disabledReason="Wait for the current request to finish or refresh access." onClick={async () => {
                  const result = await mutate("renew:" + invite.id, () => api<{ invite: Invite; inviteUrl: string }>("/api/workspace/invites/" + encodeURIComponent(invite.id) + "/resend", { method: "POST", body: JSON.stringify({ workspaceId }) }), "Invitation renewed for " + invite.email + ". Share the new link.");
                  if (result) setInviteLink(new URL(result.inviteUrl, window.location.origin).href);
                }}>Renew invite</Button>
                <Button size="sm" variant="ghost" busy={busy === "revoke:" + invite.id} disabled={blocked} disabledReason="Wait for the current request to finish or refresh access." aria-label={"Revoke invite for " + invite.email} onClick={() => void mutate("revoke:" + invite.id, () => api("/api/workspace/invites/" + encodeURIComponent(invite.id) + "?" + query, { method: "DELETE" }), "Invitation revoked for " + invite.email + ".")}>Revoke</Button>
              </>}
            </li>;
          })}
        </ul>}
      </Card>}

      <Card title={isOwner ? "Workspace ownership" : "Your membership"} subtitle={owner ? owner.name + " (" + owner.email + ") owns this workspace." : "Ownership is separate from the admin role."}>
        {isOwner ? <div className="space-y-4">
          <p className="max-w-[70ch] text-sm text-ink-mute">Transfer ownership to an existing member. They become an admin and control admin access and future ownership transfers. You remain an admin.</p>
          {transferable.length ? <div className="flex flex-wrap items-end gap-3">
            <Field label="New owner" className="min-w-0 flex-1"><Select value={transferMember} onChange={(event) => setTransferMember(event.target.value)} disabled={blocked} options={[{ value: "", label: "Choose a member" }, ...transferable.map((member) => ({ value: member.id, label: member.name + " · " + member.email }))]} /></Field>
            <Button variant="quiet" disabled={!transferMember || blocked} disabledReason="Choose an existing member and wait for any current request." onClick={() => { const member = members.find((row) => row.id === transferMember); if (member) setConfirmation({ kind: "transfer", member }); }}>Transfer ownership…</Button>
          </div> : <p className="text-sm text-ink-faint">Invite another person and have them accept before transferring ownership.</p>}
          <p className="text-xs text-ink-faint">Transfer ownership before leaving this workspace or deleting your account.</p>
        </div> : <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-[65ch] text-sm text-ink-mute">Leaving removes your access to every project in this workspace. An admin can invite you back.</p><Button variant="quiet" disabled={blocked || !boot.auth.configured} disabledReason="Leaving requires a signed-in account and current workspace access." onClick={() => setConfirmation({ kind: "leave" })}>Leave workspace…</Button></div>}
      </Card>

      <Dialog open={!!confirmation} onClose={closeConfirmation} tone={confirmation?.kind === "role" ? "default" : "danger"} width={520}
        title={confirmation?.kind === "transfer" ? "Transfer ownership of " + workspace.name : confirmation?.kind === "remove" ? "Remove " + confirmation.member.name : confirmation?.kind === "leave" ? "Leave " + workspace.name : "Change workspace role"}
        footer={<><Button variant="quiet" disabled={!!busy} disabledReason="Wait for the current request." onClick={closeConfirmation}>Cancel</Button><Button variant={confirmation?.kind === "role" ? "primary" : "danger"} busy={busy === "confirmation"} disabled={!!sharing.error || (confirmation?.kind === "transfer" && transferName !== workspace.name)} disabledReason={sharing.error ? "Refresh workspace access before making changes." : "Type the workspace name to confirm ownership transfer."} onClick={() => void confirm()}>{confirmation?.kind === "transfer" ? "Transfer ownership" : confirmation?.kind === "remove" ? "Remove member" : confirmation?.kind === "leave" ? "Leave workspace" : "Change role"}</Button></>}>
        <div className="space-y-4 text-sm leading-relaxed text-ink-mute">
          {confirmation?.kind === "role" && <p>{confirmation.member.name} ({confirmation.member.email}) will change from {confirmation.member.role} to <strong className="text-ink">{confirmation.role}</strong> in every project in {workspace.name}. {WORKSPACE_ROLES.find((role) => role.value === confirmation.role)?.description}</p>}
          {confirmation?.kind === "remove" && <p>{confirmation.member.name} ({confirmation.member.email}) will lose access to every project in {workspace.name} on their next request. Their work and audit history remain. Invite them again if they need access later.</p>}
          {confirmation?.kind === "leave" && <p>You will lose access to every project in {workspace.name}. Your work and audit history remain. You will need a new invitation to return.</p>}
          {confirmation?.kind === "transfer" && <><p><strong className="text-ink">{confirmation.member.name} ({confirmation.member.email})</strong> will own this workspace. You remain an admin, and only the new owner can transfer ownership back or manage admin access.</p><Field label={"Type " + workspace.name + " to confirm"}><Input autoComplete="off" value={transferName} onChange={(event) => setTransferName(event.target.value)} /></Field></>}
          {!!error && <ErrorNote error={error} />}
        </div>
      </Dialog>
    </div>
  );
}

function InviteForm({ busy, roles, onInvite }: { busy: boolean; roles: typeof WORKSPACE_ROLES; onInvite: (email: string, role: Role) => Promise<boolean> }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  return <Card title="Invite people" subtitle="Invite an existing account or someone new. They must sign in with this exact email to accept.">
    <form onSubmit={async (event) => { event.preventDefault(); if (!busy && await onInvite(email.trim().toLowerCase(), role)) setEmail(""); }}>
      <div className="grid gap-4 sm:grid-cols-[1fr_150px]">
        <Field label="Email address" required><Input type="email" required maxLength={254} value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} placeholder="person@example.com" autoComplete="off" /></Field>
        <Field label="Workspace role" required><Select value={role} disabled={busy} onChange={(event) => setRole(event.target.value as Role)} options={roles} /></Field>
      </div>
      <p className="mt-3 text-xs text-ink-mute">{WORKSPACE_ROLES.find((option) => option.value === role)?.description}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3"><Button type="submit" variant="primary" icon={<UserPlus size={15} aria-hidden="true" />} busy={busy} disabled={!email.trim()} disabledReason="Enter the email address to invite.">Create invitation</Button><span className="text-xs text-ink-faint">You will receive a link to share. No email is sent.</span></div>
    </form>
  </Card>;
}
