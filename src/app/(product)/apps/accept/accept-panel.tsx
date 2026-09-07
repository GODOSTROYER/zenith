"use client";
/**
 * Accepting an invitation — the one Zenith page a recipient ever has to see.
 *
 * It does one thing: hand the token to the server and report the answer. On
 * success the only control is the app itself; on refusal the three reasons an
 * invitation stops working are spelled out, together with the address the
 * person is actually signed in as, because that is usually the mismatch.
 *
 * Workstream W9 (hosted R3)
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorNote, errorText, useSafeToasts } from "@/components/screens/shared";
import { useShell } from "@/components/shell/shell-context";
import { acceptHostedInvite, launchHostedApp, type AcceptResult } from "@/lib/client/hosted";

export interface AcceptPanelProps {
  /** the `token` query parameter, or null when the link arrived without one */
  token: string | null;
}

const WHY = [
  "It was sent to a different email address than the one you are signed in with.",
  "It is more than 48 hours old.",
  "It has already been used, or the person who sent it cancelled it.",
];

export function AcceptPanel({ token }: AcceptPanelProps) {
  const { boot } = useShell();
  const toasts = useSafeToasts();
  const [result, setResult] = useState<AcceptResult | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(Boolean(token));
  const [opening, setOpening] = useState(false);
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (!token || sent.current === token) return;
    sent.current = token;
    let alive = true;
    setBusy(true);
    acceptHostedInvite(token)
      .then((accepted) => {
        if (alive) setResult(accepted);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [token]);

  const open = async () => {
    if (!result) return;
    setOpening(true);
    try {
      await launchHostedApp(result.app.id);
    } catch (cause) {
      const { message, fix } = errorText(cause);
      toasts.push({ kind: "err", title: message, body: fix });
      setOpening(false);
    }
  };

  if (!token)
    return (
      <Card title="This invitation link is incomplete">
        <p className="max-w-[60ch] text-[13px] text-ink">
          The link is missing its invitation code, so there is nothing to accept.
        </p>
        <p className="mt-1.5 max-w-[60ch] text-[13px] text-ink-mute">
          Open the link from the invitation exactly as it was sent — copying only part of it leaves
          the code behind.
        </p>
      </Card>
    );

  if (busy)
    return (
      <Card title="Checking your invitation">
        <div className="space-y-2">
          <Skeleton height={14} width="60%" />
          <Skeleton height={12} />
          <Skeleton height={12} width="80%" />
        </div>
      </Card>
    );

  if (result)
    return (
      <Card title={`You now have access to ${result.app.name}`}>
        <p className="max-w-[60ch] text-[13px] text-ink">
          You can open {result.app.name} as {result.grant.role}. This is the only Zenith page you
          need — from now on, go straight to the app.
        </p>
        <div className="mt-4">
          <Button
            variant="primary"
            busy={opening}
            onClick={() => void open()}
            icon={<ExternalLink className="h-4 w-4" aria-hidden="true" />}
          >
            Open {result.app.name}
          </Button>
        </div>
      </Card>
    );

  return (
    <Card title="This invitation cannot be accepted">
      <ErrorNote error={error} />
      <p className="mt-4 text-[13px] text-ink">An invitation stops working for three reasons:</p>
      <ul className="mt-2 space-y-1.5 border-l border-line pl-4 text-[13px] text-ink-mute">
        {WHY.map((why) => (
          <li key={why}>{why}</li>
        ))}
      </ul>
      {boot?.user?.email ? (
        <Callout tone="info" compact className="mt-4">
          <p>
            You are signed in as <span className="font-mono">{boot.user.email}</span>. An invitation
            only works for the address it was sent to.
          </p>
        </Callout>
      ) : null}
      <p className="mt-4 max-w-[60ch] text-[13px] text-ink-mute">
        Ask whoever invited you to send a new invitation, then open that link.{" "}
        <Link
          href="/apps"
          className="underline decoration-line-strong underline-offset-4 hover:text-ink"
        >
          Your own apps
        </Link>{" "}
        are unaffected.
      </p>
    </Card>
  );
}
