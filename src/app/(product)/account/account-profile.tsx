"use client";
/**
 * The three things about your sign-in: the name people see, the address you
 * sign in with, and the password.
 *
 * Two of them go straight to Supabase from the browser, exactly as the sign-in
 * form does, because both are about the session this browser holds and neither
 * needs the server to be involved. The display name goes through the API
 * instead: the member row is a server-side copy that has to move with it.
 */
import { useState } from "react";
import { api } from "@/lib/client/api";
import { createClient } from "@/lib/supabase/client";
import { explain } from "@/components/auth/messages";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorText } from "@/components/screens/shared";

/** One notice slot per card: the last thing that happened, in the app's voice. */
export type Note = { kind: "ok" | "err"; text: string } | undefined;

export function NoteLine({ note }: { note: Note }) {
  if (!note) return null;
  return (
    <Callout tone={note.kind === "ok" ? "ok" : "err"} className="mt-4">
      <p>{note.text}</p>
    </Callout>
  );
}

/* ------------------------------ display name ------------------------------ */

export function DisplayNameCard({
  currentName,
  onSaved,
}: {
  currentName: string;
  /** re-read the shell, so the header chip and the member list catch up */
  onSaved: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const trimmed = name.trim();
  const unchanged = trimmed === currentName;

  const save = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      await api("/api/account/profile", {
        method: "PATCH",
        body: JSON.stringify({ name: trimmed }),
      });
      setNote({ kind: "ok", text: `You are ${trimmed} everywhere from now on.` });
      onSaved();
    } catch (e) {
      const { message, fix } = errorText(e);
      setNote({ kind: "err", text: fix ? `${message} ${fix}` : message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Display name"
      subtitle="Shown in the member list, in the header, and beside anything you do from now on."
    >
      <Field
        label="Your name"
        help="Activity already recorded keeps the name you had when you did it — history is a record, not a profile."
      >
        <div className="flex flex-wrap gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className="min-w-[180px] flex-1"
            autoComplete="name"
          />
          <Button
            busy={busy}
            disabled={!trimmed || unchanged}
            disabledReason={trimmed ? "This is already your name." : "Enter a name."}
            onClick={save}
          >
            Save name
          </Button>
        </div>
      </Field>
      <NoteLine note={note} />
    </Card>
  );
}

/* --------------------------------- email ---------------------------------- */

export function EmailCard({ currentEmail }: { currentEmail: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const next = email.trim().toLowerCase();
  const valid = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(next);
  const same = next === currentEmail.toLowerCase();

  const submit = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const { error } = await createClient().auth.updateUser({ email: next });
      if (error) throw error;
      setEmail("");
      setNote({
        kind: "ok",
        text: `Confirmation links are on their way. Nothing changes until you open them — until then you keep signing in as ${currentEmail}.`,
      });
    } catch (e) {
      setNote({ kind: "err", text: explain(e instanceof Error ? e.message : String(e)) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Email address"
      subtitle={
        <>
          You sign in as <span className="font-mono">{currentEmail}</span>.
        </>
      }
    >
      <Field
        label="New email address"
        help="A link goes to both addresses and the change takes effect only once you have opened them. Zenith picks the new address up on your next request after that, and your member row follows it."
      >
        <div className="flex flex-wrap gap-3">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder="you@example.com"
            className="min-w-[180px] flex-1"
            autoComplete="off"
          />
          <Button
            busy={busy}
            disabled={!valid || same}
            disabledReason={
              same
                ? "That is already your address."
                : next
                  ? "That does not look like an email address."
                  : "Enter the address you want to move to."
            }
            onClick={submit}
          >
            Send confirmation links
          </Button>
        </div>
      </Field>
      <p className="mt-3 max-w-[74ch] text-[12px] text-ink-faint">
        An invite somebody sent to {currentEmail} is an offer to that address and is unaffected by
        this — if you are waiting on one, accept it before you move, or ask them to re-send it to
        the new address from Settings → Members.
      </p>
      <NoteLine note={note} />
    </Card>
  );
}

/* -------------------------------- password -------------------------------- */

export function PasswordCard({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();

  const short = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length >= 8 && next === confirm;

  const submit = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const supabase = createClient();
      // Re-authenticate before changing anything: an unattended open tab is
      // otherwise a way to take the account, and knowing the current password
      // is what separates you from whoever found the laptop.
      const { error: reauth } = await supabase.auth.signInWithPassword({
        email,
        password: current,
      });
      if (reauth)
        throw new Error(
          "That current password does not match. Retype it, or sign out and use the reset link on the sign-in page."
        );
      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) throw error;
      setCurrent("");
      setNext("");
      setConfirm("");
      setNote({
        kind: "ok",
        text: "Password changed. Other browsers keep their sessions — use “Sign out everywhere” below if you want them ended.",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setNote({
        kind: "err",
        text: message.startsWith("That current password") ? message : explain(message),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Password" subtitle="Changing it asks for the current one first.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Current password" className="sm:col-span-2">
          <Input
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            type="password"
            autoComplete="current-password"
          />
        </Field>
        <Field
          label="New password"
          help="At least 8 characters."
          error={short ? "Use at least 8 characters." : undefined}
        >
          <Input
            value={next}
            onChange={(e) => setNext(e.target.value)}
            type="password"
            autoComplete="new-password"
          />
        </Field>
        <Field
          label="New password again"
          error={mismatch ? "These two do not match. Retype the new password." : undefined}
        >
          <Input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            type="password"
            autoComplete="new-password"
          />
        </Field>
      </div>
      <div className="mt-4">
        <Button
          busy={busy}
          disabled={!ready}
          disabledReason={
            !current
              ? "Enter your current password first."
              : next.length < 8
                ? "The new password needs at least 8 characters."
                : "The two new passwords do not match yet."
          }
          onClick={submit}
        >
          Change password
        </Button>
      </div>
      <NoteLine note={note} />
    </Card>
  );
}
