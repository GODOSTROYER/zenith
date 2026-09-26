"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useShell } from "@/components/shell/shell-context";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { api, ApiError, useJson } from "@/lib/client/api";
import type { Invite } from "@/lib/domain/types";
import { fmtDate } from "@/lib/format";

interface WorkspaceInvitation extends Invite {
  workspaceName: string;
  expiresAt?: string;
  revokedAt?: string;
}

interface InvitationInbox {
  email: string;
  invitations: WorkspaceInvitation[];
}

const ROLE_HELP: Record<Invite["role"], string> = {
  viewer: "Read workspace projects and activity.",
  editor: "Create and update projects and run permitted operations.",
  admin: "Manage workspace projects, settings, viewers, and editors. The owner controls admin access.",
};

function unavailableReason(invite: WorkspaceInvitation): string | undefined {
  if (invite.revokedAt) return "This invitation was revoked. Ask a workspace admin for a new invitation.";
  if (invite.acceptedAt) return "This invitation has already been accepted.";
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now())
    return "This invitation has expired. Ask a workspace admin for a new invitation.";
  return undefined;
}

export function InvitationPanel({ inviteId }: { inviteId: string | null }) {
  const router = useRouter();
  const shell = useShell();
  // A new account may not have a workspace for bootstrap yet. This inbox only
  // needs the authenticated identity, so it must never wait for the shell.
  const inbox = useJson<InvitationInbox>("/api/workspace/invitations");
  const [accepting, setAccepting] = useState<string>();
  const [acceptError, setAcceptError] = useState<ApiError>();
  const submitting = useRef(false);
  const email = inbox.data?.email ?? shell.boot?.user?.email;
  const invitations = inbox.data?.invitations ?? [];
  const visible = inviteId ? invitations.filter((invite) => invite.id === inviteId) : invitations;
  const next = inviteId ? `/invite?invite=${encodeURIComponent(inviteId)}` : "/invite";

  async function accept(invite: WorkspaceInvitation) {
    if (submitting.current) return;
    submitting.current = true;
    setAccepting(invite.id);
    setAcceptError(undefined);
    try {
      // The server checks the signed-in email, lifetime, and offered role,
      // then selects this workspace. No client-supplied role or email is sent.
      await api(`/api/workspace/invites/${encodeURIComponent(invite.id)}/accept`, { method: "POST" });
      shell.refresh();
      router.push("/overview");
      router.refresh();
    } catch (error) {
      setAcceptError(error instanceof ApiError ? error : new ApiError("The invitation could not be accepted. Please try again.", 0));
      inbox.refresh();
    } finally {
      submitting.current = false;
      setAccepting(undefined);
    }
  }

  return (
    <div className="product-page mx-auto h-full w-full max-w-[720px] overflow-y-auto">
      <header className="app-page-heading">
        <div className="min-w-0">
          <h1 className="app-page-title">{inviteId ? "Workspace invitation" : "Workspace invitations"}</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-mute">
            Join a workspace with the access its admin has offered you.
          </p>
          {email ? <p className="mt-2 break-all text-[13px] text-ink-mute">Signed in as <span className="text-ink">{email}</span>.</p> : null}
        </div>
      </header>

      <div className="space-y-4 pb-16">
        {acceptError ? (
          <Callout tone="err" title={acceptError.message}>
            {acceptError.fix}
          </Callout>
        ) : null}

        {inbox.error ? (
          <Callout
            tone="err"
            title="Invitations could not be loaded"
            actions={<Button onClick={inbox.refresh}>Try again</Button>}
          >
            <p>{inbox.error.message}</p>
            {inbox.error.fix ? <p className="mt-1">{inbox.error.fix}</p> : null}
          </Callout>
        ) : inbox.loading && !inbox.data ? (
          <p role="status" className="text-[13px] text-ink-mute">Checking your invitations…</p>
        ) : inbox.data && visible.length === 0 ? (
          <Callout tone={inviteId ? "warn" : "info"} title={inviteId ? "This invitation is unavailable" : "No pending invitations"}>
            <p>
              {inviteId
                ? "It may have expired, been revoked, already been accepted, or been sent to a different email address."
                : "There are no pending workspace invitations for your signed-in email address."}
            </p>
            <p className="mt-2">Ask a workspace admin to send a new invitation to the email you use here.</p>
            {inviteId ? <p className="mt-2">To use another email, sign out, sign in with the invited address, and open this invitation link again.</p> : null}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {inviteId ? (
                <form action="/auth/signout" method="post">
                  <input type="hidden" name="next" value={next} />
                  <Button type="submit">Sign out to use another email</Button>
                </form>
              ) : null}
              {inviteId ? <Link href="/invite" className="text-[13px] text-signal underline underline-offset-4">View my pending invitations</Link> : null}
              {shell.boot?.workspace ? <Link href="/overview" className="text-[13px] text-signal underline underline-offset-4">Go to workspace</Link> : null}
            </div>
          </Callout>
        ) : visible.map((invite) => {
          const reason = unavailableReason(invite);
          return (
            <Card key={invite.id} title={invite.workspaceName} subtitle="You have been invited to join this workspace.">
              <dl className="space-y-3 text-[13px]">
                <div>
                  <dt className="text-ink-faint">Invited email</dt>
                  <dd className="mt-1 break-all text-ink">{invite.email}</dd>
                </div>
                <div>
                  <dt className="text-ink-faint">Your role</dt>
                  <dd className="mt-1 text-ink"><span className="capitalize">{invite.role}</span> · {ROLE_HELP[invite.role]}</dd>
                </div>
                {invite.expiresAt ? (
                  <div>
                    <dt className="text-ink-faint">Expires</dt>
                    <dd className="mt-1 text-ink"><time dateTime={invite.expiresAt}>{fmtDate(invite.expiresAt)}</time></dd>
                  </div>
                ) : null}
              </dl>
              {reason ? <Callout tone="warn" compact className="mt-4">{reason}</Callout> : null}
              <Button
                variant="primary"
                className="mt-5"
                aria-label={`Accept invitation to ${invite.workspaceName}`}
                busy={accepting === invite.id}
                disabled={Boolean(reason) || Boolean(accepting && accepting !== invite.id)}
                disabledReason={reason ?? "Wait for your current invitation to finish."}
                onClick={() => void accept(invite)}
              >
                Accept invitation
              </Button>
              <p className="mt-3 text-[12.5px] text-ink-mute">Accepting opens {invite.workspaceName} as your active workspace.</p>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
