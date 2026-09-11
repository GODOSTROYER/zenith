"use client";
/**
 * Delete your account — the one irreversible thing on this screen.
 *
 * It follows the same shape as every other destructive control in Zenith: the
 * dialog says exactly what goes and what stays before the button exists, the
 * confirm is typed rather than clicked, and a refusal leads with the reason and
 * names where the fix is.
 *
 * The refusal is computed twice on purpose. The screen works it out from the
 * workspace it can see, so "you are the only admin" is on the page before
 * anybody types their address; the API works it out across every workspace,
 * because that is the only side that can. The server's answer wins.
 */
import { useState } from "react";
import { Ban, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorText } from "@/components/screens/shared";

/**
 * The one sentence a blocked deletion says, wherever it is worked out. Both the
 * screen and `/api/account`'s 409 fix say this, so there is one wording.
 */
export const soleAdminBlock = (workspace: string): string =>
  `You are the only admin of ${workspace}. Make someone else an admin first from Settings → Members, then delete your account.`;

export function DeleteAccountCard({
  email,
  workspaceCount,
  /** the sentence, when this screen can already tell the deletion is refused */
  blocked,
}: {
  email: string;
  /** how many workspaces this person belongs to, for the dialog's second line */
  workspaceCount: number;
  blocked?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverBlock, setServerBlock] = useState<string>();
  const [error, setError] = useState<string>();

  const refusal = blocked ?? serverBlock;
  const needsTyping = typed.trim().toLowerCase() !== email.toLowerCase();

  const close = () => {
    setOpen(false);
    setTyped("");
    setError(undefined);
  };

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api("/api/account", { method: "DELETE" });
      router.replace("/login");
      router.refresh();
    } catch (e) {
      const { message, fix } = errorText(e);
      // A 409 is the last-admin refusal and belongs in the refusal slot, where
      // it leads and disables the button, rather than in the errors below it.
      const status = (e as { status?: number } | null)?.status;
      if (status === 409) setServerBlock(fix ? `${message} ${fix}` : message);
      else setError(fix ? `${message} ${fix}` : message);
      setBusy(false);
    }
  };

  return (
    <>
      <Card className="border-err/25">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-[14px] text-ink">Delete your account</h3>
            <p className="mt-1 max-w-[66ch] text-[12.5px] text-ink-mute">
              Removes your Zenith sign-in and your membership of{" "}
              {workspaceCount === 1 ? "the workspace" : `all ${workspaceCount} workspaces`} you are
              in. Nothing you built is torn down and nobody else loses anything — but you will not
              be able to reach any of it again.
            </p>
          </div>
          <Button
            variant="danger"
            icon={<Trash2 className="h-3.5 w-3.5" />}
            disabled={Boolean(refusal)}
            disabledReason={refusal}
            onClick={() => setOpen(true)}
          >
            Delete my account
          </Button>
        </div>
        {refusal && (
          <Callout
            tone="err"
            className="mt-4"
            icon={<Ban className="mt-0.5 h-4 w-4 shrink-0 text-err" aria-hidden="true" />}
          >
            <p>{refusal}</p>
          </Callout>
        )}
      </Card>

      <Dialog
        open={open}
        onClose={close}
        title="Delete your account"
        tone="danger"
        width={520}
        footer={
          <>
            <Button variant="quiet" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              busy={busy}
              disabled={needsTyping || Boolean(refusal)}
              disabledReason={
                refusal ? refusal : `Type ${email} to confirm.`
              }
              onClick={() => void remove()}
            >
              Delete my account
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <ul className="space-y-2 text-[13px] text-ink-mute">
            <li>
              This deletes the Zenith sign-in for{" "}
              <span className="font-mono text-ink">{email}</span>. It cannot be undone, and signing
              up again with the same address gives you a new account, not this one back.
            </li>
            <li>
              It removes you from{" "}
              {workspaceCount === 1 ? "1 workspace" : `${workspaceCount} workspaces`}. Their
              projects, environments and revisions stay exactly as they are, for the people still
              in them.
            </li>
            <li>
              Hosted apps you can open stop opening. Any session you have on one ends immediately,
              and the access that let you in is revoked.
            </li>
            <li>
              Activity history keeps your name on what you already did. Those rows are the record
              of who changed what, and they are not yours to erase.
            </li>
          </ul>

          {refusal ? (
            <Callout
              tone="err"
              icon={<Ban className="mt-0.5 h-4 w-4 shrink-0 text-err" aria-hidden="true" />}
            >
              <p>{refusal}</p>
            </Callout>
          ) : (
            <label className="block space-y-1.5">
              <span className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">
                Type <span className="font-mono text-ink">{email}</span> to confirm
              </span>
              <Input
                mono
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={email}
                autoComplete="off"
              />
            </label>
          )}

          {error && (
            <Callout tone="err">
              <p>{error}</p>
            </Callout>
          )}
        </div>
      </Dialog>
    </>
  );
}
