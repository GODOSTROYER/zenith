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
import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
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

type PasswordAccount = { id: string; email: string; externalOnly: boolean };

/** Identity providers describe sign-in options, not whether a password exists. */
function passwordAccount(user: User | null, expectedEmail: string): PasswordAccount {
  if (!user || user.is_anonymous || !user.email || user.email.toLowerCase() !== expectedEmail.toLowerCase())
    throw new Error("Your signed-in account changed. Reload this page before updating its password.");
  const identities = user.identities ?? [];
  return {
    id: user.id,
    email: user.email,
    externalOnly:
      identities.length > 0 &&
      identities.every((identity) => identity.provider !== "email" && identity.provider !== "phone"),
  };
}

function authErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
    return error.code;
}

export function PasswordCard({ email }: { email: string }) {
  const [account, setAccount] = useState<PasswordAccount | null>();
  const [reload, setReload] = useState(0);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [needsNonce, setNeedsNonce] = useState(false);
  const [nonceSent, setNonceSent] = useState(false);
  const [nonce, setNonce] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();

  useEffect(() => {
    let alive = true;
    setAccount(undefined);
    setNote(undefined);
    setCurrent("");
    setNext("");
    setConfirm("");
    setNeedsNonce(false);
    setNonceSent(false);
    setNonce("");
    void (async () => {
      try {
        const { data, error } = await createClient().auth.getUser();
        if (error) throw error;
        const verified = passwordAccount(data.user, email);
        if (alive) setAccount(verified);
      } catch {
        if (alive) {
          setAccount(null);
          setNote({ kind: "err", text: "We could not verify your signed-in account. Retry, or sign in again." });
        }
      }
    })();
    return () => { alive = false; };
  }, [email, reload]);

  const short = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && next !== confirm;
  const ready =
    Boolean(account) &&
    (account?.externalOnly || current.length > 0) &&
    next.length >= 8 &&
    next === confirm &&
    (!needsNonce || (nonceSent && nonce.trim().length > 0));

  const verifiedAccount = async (supabase: ReturnType<typeof createClient>) => {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;
    const verified = passwordAccount(data.user, email);
    if (!account || verified.id !== account.id)
      throw new Error("Your signed-in account changed. Reload this page before updating its password.");
    return verified;
  };

  const sendNonce = async (supabase: ReturnType<typeof createClient>) => {
    setNeedsNonce(true);
    setNonceSent(false);
    setNonce("");
    const { error } = await supabase.auth.reauthenticate();
    if (error) throw error;
    setNonceSent(true);
    setNote({
      kind: "ok",
      text: "A verification code is on its way to your confirmed email address or phone number. Enter it below, then save your password.",
    });
  };

  const fail = (error: unknown) => {
    const code = authErrorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    setNote({
      kind: "err",
      text:
        code === "reauthentication_not_valid"
          ? "That verification code is invalid or expired. Retype it, or send a new code."
          : message.startsWith("Your signed-in account") || message.startsWith("That current password")
            ? message
            : explain(message),
    });
  };

  const submit = async () => {
    if (!ready || busy || !account) return;
    setBusy(true);
    setNote(undefined);
    try {
      const supabase = createClient();
      const verified = await verifiedAccount(supabase);
      if (account.externalOnly && !verified.externalOnly) {
        setAccount(verified);
        setNote({
          kind: "err",
          text: "Your sign-in options changed. Enter your current password, or use the email password link.",
        });
        return;
      }
      if (!account.externalOnly) {
        // An email identity can also mean magic-link sign-in. The email-link
        // action below covers anyone who has no current password to verify.
        const { data, error } = await supabase.auth.signInWithPassword({
          email: verified.email,
          password: current,
        });
        if (error)
          throw new Error("That current password does not match. Retype it, or use the email password link.");
        if (data.user?.id !== verified.id) {
          await supabase.auth.signOut({ scope: "local" });
          throw new Error("Your signed-in account changed. Reload this page before updating its password.");
        }
      }
      const { error } = await supabase.auth.updateUser({
        password: next,
        ...(!account.externalOnly ? { current_password: current } : {}),
        ...(needsNonce ? { nonce: nonce.trim() } : {}),
      });
      if (error) {
        const code = authErrorCode(error);
        if (["reauthentication_needed", "reauthentication_required", "reauth_nonce_missing", "nonce_required"].includes(code ?? "")) {
          // Supabase enforces a nonce only when its secure-password policy
          // requires one. Sending a code alone is not proof of verification.
          await sendNonce(supabase);
          return;
        }
        if (code === "current_password_required" || code === "current_password_mismatch") {
          setAccount({ ...verified, externalOnly: false });
          setNote({
            kind: "err",
            text: "Enter your current password to change it, or use the email password link.",
          });
          return;
        }
        throw error;
      }
      // This successful write is evidence of a password even on Auth versions
      // that do not add an email identity when an OAuth user sets one.
      setAccount({ ...verified, externalOnly: false });
      setCurrent("");
      setNext("");
      setConfirm("");
      setNeedsNonce(false);
      setNonceSent(false);
      setNonce("");
      setNote({
        kind: "ok",
        text: "Password saved. You can now sign in with your email and password. Use “Sign out everywhere” below to end your other sessions.",
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const resendNonce = async () => {
    if (!account || busy) return;
    setBusy(true);
    setNote(undefined);
    try {
      const supabase = createClient();
      await verifiedAccount(supabase);
      await sendNonce(supabase);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const emailPasswordLink = async () => {
    if (!account || busy) return;
    setBusy(true);
    setNote(undefined);
    try {
      const supabase = createClient();
      const verified = await verifiedAccount(supabase);
      const { error } = await supabase.auth.resetPasswordForEmail(verified.email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });
      if (error) throw error;
      setCurrent("");
      setNext("");
      setConfirm("");
      setNonce("");
      setNeedsNonce(false);
      setNonceSent(false);
      setNote({
        kind: "ok",
        text: `Open the password link sent to ${verified.email} in this browser to choose a password.`,
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Password"
      subtitle={
        account?.externalOnly
          ? "Add email and password sign-in to this account. Your connected sign-in providers remain available."
          : "Use your current password, or request an email link if you have not set one or have forgotten it."
      }
    >
      {account === undefined && <p role="status" className="mb-4 text-[13px] text-ink-mute">Checking your sign-in options…</p>}
      {account === null && (
        <Button onClick={() => setReload((value) => value + 1)}>Retry account check</Button>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {account && !account.externalOnly && (
          <Field label="Current password" className="sm:col-span-2">
            <Input
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              type="password"
              autoComplete="current-password"
              disabled={busy}
            />
          </Field>
        )}
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
            disabled={busy || !account}
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
            disabled={busy || !account}
          />
        </Field>
        {needsNonce && (
          <Field label="Verification code" className="sm:col-span-2" help="Use the code from your most recent verification message.">
            <Input
              value={nonce}
              onChange={(e) => setNonce(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              disabled={busy || !nonceSent}
            />
          </Field>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button
          busy={busy}
          disabled={!ready}
          disabledReason={
            !account
              ? "Verify your signed-in account first."
              : !account.externalOnly && !current
                ? "Enter your current password first, or use the email password link."
                : next.length < 8
                  ? "The new password needs at least 8 characters."
                  : next !== confirm
                    ? "The two new passwords do not match yet."
                    : "Request and enter your verification code first."
          }
          onClick={submit}
        >
          {account?.externalOnly ? "Set or change password" : "Change password"}
        </Button>
        {needsNonce && (
          <Button disabled={busy} onClick={resendNonce} disabledReason="Wait for the current request to finish.">
            {nonceSent ? "Send a new code" : "Send verification code"}
          </Button>
        )}
        <Button
          disabled={busy || !account}
          disabledReason={busy ? "Wait for the current request to finish." : "Verify your signed-in account first."}
          onClick={emailPasswordLink}
        >
          Email password link
        </Button>
      </div>
      <NoteLine note={note} />
    </Card>
  );
}
