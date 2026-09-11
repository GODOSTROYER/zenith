"use client";
/**
 * Sign out everywhere, and take the export with you.
 *
 * Both are one button and one sentence about what it actually does. The sign
 * out includes this browser — a control that quietly spared the tab you are in
 * would be lying about the word "everywhere" — so it ends by sending you to the
 * sign-in page.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, LogOut } from "lucide-react";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { errorText } from "@/components/screens/shared";
import { NoteLine, type Note } from "./account-profile";

export function SessionsCard() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();

  const signOutEverywhere = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      await api("/api/account/sessions", { method: "DELETE" });
      router.replace("/login");
      router.refresh();
    } catch (e) {
      const { message, fix } = errorText(e);
      setNote({ kind: "err", text: fix ? `${message} ${fix}` : message });
      setBusy(false);
    }
  };

  return (
    <Card
      title="Sign out everywhere"
      subtitle="Ends every Zenith session on every device, and every hosted app session opened with this account — including the one you are using now."
    >
      <p className="max-w-[74ch] text-[13px] text-ink-mute">
        Worth doing after a password change you made because something felt wrong, or when a device
        you signed in on is no longer yours. It does not change your password and it does not
        remove you from any workspace: it only makes everyone sign in again, starting with you.
      </p>
      <div className="mt-4">
        <Button
          variant="quiet"
          icon={<LogOut className="h-3.5 w-3.5" />}
          busy={busy}
          onClick={() => void signOutEverywhere()}
        >
          Sign out everywhere
        </Button>
      </div>
      <NoteLine note={note} />
    </Card>
  );
}

/* --------------------------------- export --------------------------------- */

/** The filename the server named, or a sane one if the header was stripped. */
export function filenameFrom(disposition: string | null, fallback: string): string {
  const match = /filename="?([^";]+)"?/i.exec(disposition ?? "");
  return match?.[1]?.trim() || fallback;
}

export function ExportCard() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();

  const download = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const res = await fetch("/api/account/export");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { message?: string; fix?: string };
        };
        throw new Error(
          [body.error?.message, body.error?.fix].filter(Boolean).join(" ") ||
            "The export could not be built. Try again in a moment."
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFrom(res.headers.get("content-disposition"), "zenith-account.json");
      a.click();
      URL.revokeObjectURL(url);
      setNote({ kind: "ok", text: "Saved. The file lists what it holds and what it leaves out." });
    } catch (e) {
      setNote({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Export my data"
      subtitle="One JSON file: the workspaces you belong to, your membership in each, their projects, environments and revisions, and the activity rows with your name on them."
    >
      <p className="max-w-[74ch] text-[13px] text-ink-mute">
        No secret values, no provider credentials, and nothing about other members. Manifests and
        runnable files are a different export, per environment, under Settings → Export.
      </p>
      <div className="mt-4">
        <Button
          variant="quiet"
          icon={<Download className="h-3.5 w-3.5" />}
          busy={busy}
          onClick={() => void download()}
        >
          Download my data
        </Button>
      </div>
      <NoteLine note={note} />
    </Card>
  );
}
