"use client";
/**
 * The one form behind login, signup, forgot-password and reset-password.
 * Each mode calls the matching supabase-js method through the browser
 * client; cookies carry the session to the server automatically.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import {
  OAUTH_PROVIDER_LABEL,
  SUPABASE_OAUTH_PROVIDERS,
  type OAuthProvider,
} from "@/lib/supabase/env";
import { explain, isUnconfirmedEmail, messageForErrorCode } from "./messages";

export type AuthMode = "login" | "signup" | "forgot" | "reset";

const COPY: Record<AuthMode, { title: string; body: string; cta: string }> = {
  login: { title: "Welcome back.", body: "Sign in to your workspace.", cta: "Sign in" },
  signup: {
    title: "Create your account.",
    body: "Your own workspace, your own cloud, no lock-in.",
    cta: "Create account",
  },
  forgot: {
    title: "Reset your password.",
    body: "We will email you a link. It expires in an hour.",
    cta: "Send reset link",
  },
  reset: {
    title: "Choose a new password.",
    body: "At least 8 characters. Make it one you will remember.",
    cta: "Update password",
  },
};

/** Placeholder while the client form (it reads the query string) hydrates. */
export function AuthFormSkeleton() {
  return (
    <div className="rounded-[12px] border border-line bg-bg1 p-6 sm:p-7" aria-hidden="true">
      <Skeleton height={26} width="60%" />
      <div className="mt-3">
        <Skeleton height={16} width="80%" />
      </div>
      <div className="mt-8 space-y-5">
        <Skeleton height={44} />
        <Skeleton height={44} />
        <Skeleton height={32} />
      </div>
    </div>
  );
}

/** Reveal toggle, parked in the input's trailing slot. */
function RevealButton({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const Icon = shown ? EyeOff : Eye;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={shown}
      aria-label={shown ? "Hide password" : "Show password"}
      title={shown ? "Hide password" : "Show password"}
      className="-mr-1 grid h-6 w-6 place-items-center rounded-[6px] text-ink-faint transition-colors duration-[120ms] hover:text-ink"
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/overview";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(() =>
    messageForErrorCode(params.get("error"))
  );
  /** the account exists but was never confirmed — offer to send the link again */
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [done, setDone] = useState<string>();
  /**
   * /reset-password is only usable with the recovery session the emailed link
   * establishes. Without one, updateUser would fail with a stranger's error.
   */
  const [recovery, setRecovery] = useState<"checking" | "ok" | "none">(
    mode === "reset" ? "checking" : "ok"
  );
  const c = COPY[mode];

  useEffect(() => {
    if (mode !== "reset") return;
    let alive = true;
    createClient()
      .auth.getSession()
      .then(({ data }) => alive && setRecovery(data.session ? "ok" : "none"))
      .catch(() => alive && setRecovery("none"));
    return () => {
      alive = false;
    };
  }, [mode]);

  const fail = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    setUnconfirmed(isUnconfirmedEmail(message));
    setError(explain(message));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "reset" && password !== confirm) {
      setError("Those two passwords do not match. Retype the new password in both fields.");
      return;
    }
    setBusy(true);
    setError(undefined);
    setUnconfirmed(false);
    const supabase = createClient();
    const origin = window.location.origin;
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(next);
        router.refresh();
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${origin}/auth/callback?next=/overview`,
            data: { full_name: name.trim() },
          },
        });
        if (error) throw error;
        if (data.session) {
          router.replace("/overview");
          router.refresh();
        } else {
          setUnconfirmed(true);
          setDone(
            "Check your inbox — we sent a confirmation link. Open it to finish creating your account."
          );
        }
      } else if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${origin}/auth/callback?next=/reset-password`,
        });
        if (error) throw error;
        setDone("If an account exists for that email, a reset link is on its way.");
      } else {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        router.replace("/overview");
        router.refresh();
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  /** Send the confirmation email again — the same address, a fresh link. */
  async function resend() {
    setBusy(true);
    setError(undefined);
    try {
      const { error } = await createClient().auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/overview` },
      });
      if (error) throw error;
      setUnconfirmed(false);
      setDone(`A fresh confirmation link is on its way to ${email}. It expires in an hour.`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Hand off to the provider. Which providers exist is configuration
   * (NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS) matching what the operator enabled
   * in the Supabase dashboard — this never offers a door the project cannot open.
   */
  async function oauth(provider: OAuthProvider) {
    setBusy(true);
    setError(undefined);
    setUnconfirmed(false);
    try {
      const { error } = await createClient().auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (error) throw error;
      // Success navigates this tab to the provider; `busy` stays on so the
      // page does not look idle during the hop.
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  }

  /** Only sign-in and sign-up offer providers; the password pages are email-only. */
  const providers = mode === "login" || mode === "signup" ? SUPABASE_OAUTH_PROVIDERS : [];

  const resendButton = email.trim() ? (
    <Button variant="quiet" size="sm" busy={busy} onClick={resend}>
      Send the confirmation email again
    </Button>
  ) : null;

  return (
    <div className="rounded-[12px] border border-line bg-bg1 p-6 sm:p-7">
      <h1 className="text-[24px] font-bold leading-[1.1] tracking-[-0.02em] text-ink">{c.title}</h1>
      <p className="mt-1.5 text-[14px] text-ink-mute">{c.body}</p>

      {/* Above the form, and only while the form is the thing on screen: once
          `done` replaces it with "check your inbox", a provider button would be
          offering a second way in beside an instruction to finish the first. */}
      {providers.length > 0 && !done && (
        <>
          <div className="mt-6 space-y-2.5">
            {providers.map((p) => (
              <Button key={p} block busy={busy} onClick={() => oauth(p)}>
                Continue with {OAUTH_PROVIDER_LABEL[p]}
              </Button>
            ))}
          </div>
          <div className="mt-5 flex items-center gap-3 text-[12px] text-ink-faint">
            <span aria-hidden className="h-px flex-1 bg-line" />
            or
            <span aria-hidden className="h-px flex-1 bg-line" />
          </div>
        </>
      )}

      {done ? (
        <div
          role="status"
          className="mt-6 rounded-[10px] border border-line bg-bg2 p-4 text-[14px] leading-[1.6] text-ink-mute"
        >
          {done}
          {unconfirmed && resendButton && <div className="mt-3">{resendButton}</div>}
          <div className="mt-3">
            <Link href="/login" className="text-signal hover:underline">
              Back to sign in
            </Link>
          </div>
        </div>
      ) : recovery === "checking" ? (
        <div className="mt-6 space-y-3">
          <Skeleton height={44} />
          <Skeleton height={32} />
        </div>
      ) : recovery === "none" ? (
        <div
          role="status"
          className="mt-6 rounded-[10px] border border-line bg-bg2 p-4 text-[14px] leading-[1.6] text-ink-mute"
        >
          Open the reset link from your email first. This page can only set a new password while
          that link&apos;s session is active — it expires an hour after it is sent.
          <div className="mt-3">
            <Link href="/forgot-password" className="text-signal hover:underline">
              Send me a new reset link
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          {mode === "signup" && (
            <Field label="Name" help="Shown on your changes and in the audit log.">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                autoFocus
                required
              />
            </Field>
          )}
          {mode !== "reset" && (
            <Field label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus={mode !== "signup"}
                required
              />
            </Field>
          )}
          {mode !== "forgot" && (
            <Field
              label={mode === "reset" ? "New password" : "Password"}
              help={mode === "signup" || mode === "reset" ? "At least 8 characters." : undefined}
            >
              <Input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={mode === "login" ? undefined : 8}
                autoFocus={mode === "reset"}
                required
                suffix={
                  <RevealButton
                    shown={showPassword}
                    onToggle={() => setShowPassword((s) => !s)}
                  />
                }
              />
            </Field>
          )}
          {mode === "reset" && (
            <Field label="New password again" help="Both fields must match before it is saved.">
              <Input
                type={showPassword ? "text" : "password"}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </Field>
          )}

          {error && (
            <div role="alert" className="rounded-[8px] bg-err-dim px-3 py-2 text-[13px] leading-[1.5] text-err">
              {error}
              {unconfirmed && resendButton && <div className="mt-2">{resendButton}</div>}
            </div>
          )}

          <Button type="submit" variant="primary" busy={busy} block>
            {c.cta}
          </Button>
        </form>
      )}

      <div className="mt-5 flex flex-wrap justify-between gap-2 text-[13px] text-ink-faint">
        {mode === "login" && (
          <>
            <Link href="/forgot-password" className="hover:text-ink">
              Forgot password?
            </Link>
            <span>
              New here?{" "}
              <Link href="/signup" className="text-signal hover:underline">
                Create an account
              </Link>
            </span>
          </>
        )}
        {mode === "signup" && (
          <span>
            Already have an account?{" "}
            <Link href="/login" className="text-signal hover:underline">
              Sign in
            </Link>
          </span>
        )}
        {(mode === "forgot" || mode === "reset") && (
          <Link href="/login" className="hover:text-ink">
            Back to sign in
          </Link>
        )}
      </div>
    </div>
  );
}
