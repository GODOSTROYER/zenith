"use client";
/**
 * Invite someone to an app by email address. The address is the whole
 * invitation: it only works for the person who can prove that address, and it
 * expires after 48 hours.
 *
 * The result panel is deliberately unglamorous — it reports what the mail
 * server did, not what we hope happened, and hands over the link when nothing
 * was sent.
 *
 * Workstream W9 (hosted R3)
 */
import { useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ErrorNote } from "@/components/screens/shared";
import { createInvite, type IssuedInvite } from "@/lib/client/hosted";
import type { AppRole } from "@/lib/hosted/contracts";
import { APP_ROLE_OPTIONS, APP_ROLE_TEXT } from "./labels";
import { DeliveryNote } from "./delivery-note";

export interface InviteFormProps {
  appId: string;
  appName: string;
  /** why inviting is refused right now */
  disabledReason?: string;
  onInvited: () => void;
}

const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export function InviteForm({ appId, appName, disabledReason, onInvited }: InviteFormProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AppRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<IssuedInvite | null>(null);

  const trimmed = email.trim();
  const reason =
    disabledReason ??
    (!trimmed
      ? "Type the email address of the person you want to invite."
      : !looksLikeEmail(trimmed)
        ? `“${trimmed}” is not an email address. Invitations only work for an address the person can prove is theirs.`
        : undefined);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const invited = await createInvite(appId, { email: trimmed.toLowerCase(), role });
      setResult(invited);
      setEmail("");
      onInvited();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason && !busy) void submit();
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <Field
          label="Email address"
          help="The invitation only works for this address, and expires after 48 hours."
          className="min-w-0 flex-1 sm:max-w-[420px]"
        >
          <Input
            type="email"
            value={email}
            autoComplete="off"
            placeholder="person@example.com"
            disabled={Boolean(disabledReason)}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="They can" help={APP_ROLE_TEXT[role]} className="min-w-0 sm:w-[260px]">
          <Select
            value={role}
            options={APP_ROLE_OPTIONS}
            disabled={Boolean(disabledReason)}
            onChange={(event) => setRole(event.target.value as AppRole)}
          />
        </Field>
      </div>

      {error ? <ErrorNote error={error} /> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={Boolean(reason)}
          disabledReason={reason}
          icon={<UserPlus className="h-4 w-4" aria-hidden="true" />}
        >
          Send invitation
        </Button>
        {disabledReason ? (
          <span className="max-w-[60ch] text-[12.5px] text-ink-mute">{disabledReason}</span>
        ) : null}
      </div>

      {result ? (
        <div className="rounded-card border border-line bg-bg1 p-4">
          <p className="text-[13px] text-ink">
            {result.invite.email} was invited to {appName} as {result.invite.role}.
          </p>
          <DeliveryNote
            delivery={result.delivery}
            acceptUrl={result.acceptUrl}
            email={result.invite.email}
            className="mt-2"
          />
        </div>
      ) : null}
    </form>
  );
}
