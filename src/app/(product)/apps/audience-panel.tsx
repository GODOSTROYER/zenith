"use client";
/**
 * Who can open this app. Grants are the answer the gateway actually asks on
 * every request, so this list is the app's door — not a hint about it.
 *
 * Two rules shape it. The last owner cannot be removed or demoted, and the
 * control says so before it is pressed rather than after a 409. And revoking
 * is explained in terms of what the person will experience, because that is the
 * thing the owner is actually deciding.
 *
 * Workstream W9 (hosted R3)
 */
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table } from "@/components/ui/table";
import { TimeAgo } from "@/components/ui/time-ago";
import { ErrorNote, errorText, useSafeToasts } from "@/components/screens/shared";
import {
  changeGrantRole,
  resendInvite,
  revokeGrant,
  revokeInvite,
  useHostedGrants,
  useHostedInvites,
  type IssuedInvite,
} from "@/lib/client/hosted";
import type { AppGrant, AppInvite, AppRole } from "@/lib/hosted/contracts";
import { APP_ROLE_OPTIONS, APP_ROLE_TEXT, GRANT_STATE, INVITE_STATE } from "./labels";
import { DeliveryNote } from "./delivery-note";
import { InviteForm } from "./invite-form";

export interface AudiencePanelProps {
  appId: string;
  appName: string;
  /** what the app payload already carried, used until the audience loads */
  grants?: AppGrant[];
  invites?: AppInvite[];
  /** false when the caller is not an owner of this app */
  canManage: boolean;
  /** why managing the audience is refused */
  manageDisabledReason?: string;
  onChanged: () => void;
}

const EMPTY_GRANTS: AppGrant[] = [];
const EMPTY_INVITES: AppInvite[] = [];

export function AudiencePanel({
  appId,
  appName,
  grants: seedGrants,
  invites: seedInvites,
  canManage,
  manageDisabledReason,
  onChanged,
}: AudiencePanelProps) {
  const toasts = useSafeToasts();
  const grantsQuery = useHostedGrants(canManage ? appId : null);
  const invitesQuery = useHostedInvites(canManage ? appId : null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AppGrant | null>(null);
  const [resent, setResent] = useState<IssuedInvite | null>(null);

  const grants = grantsQuery.data?.grants ?? seedGrants ?? EMPTY_GRANTS;
  const invites = invitesQuery.data?.invites ?? seedInvites ?? EMPTY_INVITES;
  // The invitations list carries no delivery rows, so what happened to the
  // email is known only for one this screen just created or resent.
  const issuedFor = (inviteId: string): IssuedInvite | undefined =>
    resent?.invite.id === inviteId ? resent : undefined;

  const owners = grants.filter((g) => g.state === "active" && g.role === "owner");
  const pending = invites.filter((i) => i.state === "pending");

  const lastOwnerReason = (grant: AppGrant): string | undefined =>
    owners.length === 1 && owners[0]?.id === grant.id
      ? `${grant.email} is the only owner of ${appName}. Make someone else an owner first — an app with no owner can never be published or shared again.`
      : undefined;

  const refreshAll = () => {
    grantsQuery.refresh();
    invitesQuery.refresh();
    onChanged();
  };

  const run = async (id: string, work: () => Promise<unknown>, ok: string): Promise<boolean> => {
    setBusyId(id);
    try {
      await work();
      toasts.push({ kind: "ok", title: ok });
      refreshAll();
      return true;
    } catch (cause) {
      const { message, fix } = errorText(cause);
      toasts.push({ kind: "err", title: message, body: fix });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const setRole = (grant: AppGrant, role: AppRole) =>
    run(
      grant.id,
      () => changeGrantRole(appId, grant.id, role),
      `${grant.email} is now ${role} on ${appName}.`
    );

  const confirmRevoke = async () => {
    if (!revoking) return;
    const done = await run(
      revoking.id,
      () => revokeGrant(appId, revoking.id),
      `${revoking.email} can no longer open ${appName}.`
    );
    if (done) setRevoking(null);
  };

  const resend = (invite: AppInvite) =>
    run(
      invite.id,
      async () => {
        const result = await resendInvite(appId, invite.id);
        setResent(result);
      },
      `A new invitation for ${invite.email} was created. The older one no longer works.`
    );

  const cancel = (invite: AppInvite) =>
    run(
      invite.id,
      () => revokeInvite(appId, invite.id),
      `The invitation for ${invite.email} was cancelled.`
    );

  if (!canManage)
    return (
      <Card>
        <p className="text-[13px] text-ink">
          {manageDisabledReason ??
            `Only an owner of ${appName} can see and change who may open it.`}
        </p>
        <p className="mt-1.5 max-w-[70ch] text-[12.5px] text-ink-mute">
          Ask an owner to invite you, or to make you an owner of this app.
        </p>
      </Card>
    );

  return (
    <div className="space-y-5">
      <Card
        title={`${grants.filter((g) => g.state === "active").length} with access`}
        subtitle="Everyone here can open the app. Access is checked on every request, so a change takes effect immediately."
        padded={false}
      >
        {grantsQuery.loading && grants.length === 0 ? (
          <div className="space-y-2 p-5">
            <Skeleton height={14} width="40%" />
            <Skeleton height={36} />
            <Skeleton height={36} />
          </div>
        ) : grantsQuery.error && grants.length === 0 ? (
          <div className="p-5">
            <ErrorNote error={grantsQuery.error} />
            <Button className="mt-3" size="sm" variant="quiet" onClick={grantsQuery.refresh}>
              Try again
            </Button>
          </div>
        ) : (
          <Table<AppGrant>
            caption={`People who can open ${appName}`}
            rows={grants}
            rowKey={(g) => g.id}
            empty={
              <Table.Empty>
                <p>Nobody has been given access yet. Invite someone below.</p>
              </Table.Empty>
            }
            columns={[
              {
                key: "email",
                header: "Person",
                render: (g) => (
                  <span className="break-all text-[13px] text-ink">{g.email}</span>
                ),
              },
              {
                key: "role",
                header: "They can",
                width: 220,
                render: (g) => {
                  const reason =
                    g.state !== "active"
                      ? `${g.email} does not have access, so there is no role to change.`
                      : lastOwnerReason(g);
                  return (
                    <>
                      <Select
                        value={g.role}
                        options={APP_ROLE_OPTIONS}
                        aria-label={`Role for ${g.email}`}
                        disabled={Boolean(reason) || busyId === g.id}
                        title={reason}
                        onChange={(event) => void setRole(g, event.target.value as AppRole)}
                      />
                      <span className="mt-1 block text-[12px] text-ink-faint">
                        {reason ?? APP_ROLE_TEXT[g.role]}
                      </span>
                    </>
                  );
                },
              },
              {
                key: "state",
                header: "Access",
                width: 150,
                render: (g) => (
                  <>
                    <Chip tone={GRANT_STATE[g.state].tone}>{GRANT_STATE[g.state].text}</Chip>
                    {GRANT_STATE[g.state].note && (
                      <span className="mt-1 block max-w-[32ch] text-[12px] text-ink-faint">
                        {GRANT_STATE[g.state].note}
                      </span>
                    )}
                  </>
                ),
              },
              {
                key: "since",
                header: "Since",
                width: 120,
                render: (g) => <TimeAgo iso={g.createdAt} className="text-[12.5px] text-ink-mute" />,
              },
              {
                key: "act",
                header: "",
                headerLabel: "Remove access",
                align: "right",
                width: 116,
                render: (g) => {
                  const reason =
                    g.state !== "active"
                      ? `${g.email} already has no access to ${appName}.`
                      : lastOwnerReason(g);
                  return (
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={Boolean(reason)}
                      disabledReason={reason}
                      busy={busyId === g.id}
                      onClick={() => setRevoking(g)}
                      icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                    >
                      Revoke
                    </Button>
                  );
                },
              },
            ]}
          />
        )}
      </Card>

      <Card
        title="Invite someone"
        subtitle="They sign in with the address you type here, and land straight in the app."
      >
        <InviteForm appId={appId} appName={appName} onInvited={refreshAll} />
      </Card>

      <Card
        title={`${pending.length} invitation${pending.length === 1 ? "" : "s"} waiting`}
        subtitle="An invitation becomes access the moment it is accepted."
        padded={false}
      >
        {invitesQuery.error && invites.length === 0 ? (
          <div className="p-5">
            <ErrorNote error={invitesQuery.error} />
            <Button className="mt-3" size="sm" variant="quiet" onClick={invitesQuery.refresh}>
              Try again
            </Button>
          </div>
        ) : invites.length === 0 ? (
          <p className="px-5 py-5 text-[13px] text-ink-mute">
            No invitations yet. The form above sends one.
          </p>
        ) : (
          <ul>
            {invites.map((invite) => {
              const label = INVITE_STATE[invite.state];
              const issued = issuedFor(invite.id);
              return (
                <li
                  key={invite.id}
                  className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b border-line px-5 py-4 last:border-b-0"
                >
                  <div className="min-w-[200px] flex-1">
                    <p className="break-all text-[13px] text-ink">{invite.email}</p>
                    <p className="mt-0.5 text-[12.5px] text-ink-mute">
                      Invited as {invite.role} ·{" "}
                      {invite.state === "pending" ? (
                        <>
                          expires <TimeAgo iso={invite.expiresAt} />
                        </>
                      ) : (
                        <TimeAgo iso={invite.createdAt} prefix="created" />
                      )}
                    </p>
                    <div className="mt-2">
                      <Chip tone={label.tone}>{label.text}</Chip>
                      {label.note && (
                        <span className="mt-1 block text-[12px] text-ink-faint">{label.note}</span>
                      )}
                    </div>
                    <DeliveryNote
                      delivery={issued?.delivery}
                      acceptUrl={issued?.acceptUrl}
                      email={invite.email}
                      className="mt-2"
                    />
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="quiet"
                      busy={busyId === invite.id}
                      disabled={invite.state !== "pending"}
                      disabledReason={
                        invite.state === "pending"
                          ? undefined
                          : `This invitation is ${label.text.toLowerCase()}, so there is nothing to resend. Invite ${invite.email} again instead.`
                      }
                      onClick={() => void resend(invite)}
                    >
                      Resend
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      busy={busyId === invite.id}
                      disabled={invite.state !== "pending"}
                      disabledReason={
                        invite.state === "pending"
                          ? undefined
                          : `This invitation is ${label.text.toLowerCase()}, so there is nothing to cancel.`
                      }
                      onClick={() => void cancel(invite)}
                    >
                      Cancel
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Dialog
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        title={revoking ? `Remove ${revoking.email}?` : "Remove access"}
        tone="danger"
        width={500}
        footer={
          <>
            <Button variant="quiet" onClick={() => setRevoking(null)} disabled={busyId !== null}>
              Cancel
            </Button>
            <Button variant="danger" busy={busyId !== null} onClick={() => void confirmRevoke()}>
              Revoke access
            </Button>
          </>
        }
      >
        <ul className="space-y-2 text-[13px] text-ink">
          <li>They lose access to {appName} immediately, including any page they have open.</li>
          <li>Their sign-in on the app host ends in the same step, so a stale tab cannot keep working.</li>
          <li className="text-ink-mute">
            Anything they created in the app stays. You can invite them again later.
          </li>
        </ul>
      </Dialog>
    </div>
  );
}
