"use client";
/**
 * The one form behind login, signup, forgot-password and reset-password.
 * Each mode calls the matching supabase-js method through the browser
 * client; cookies carry the session to the server automatically.
 */
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

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

/** Translate Supabase auth errors into calm, fix-naming copy. */
function explain(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials"))
    return "That email and password do not match. Check both, or reset your password below.";
  if (m.includes("email not confirmed"))
    return "Confirm your email first — the link is in your inbox. Then sign in again.";
  if (m.includes("already registered") || m.includes("already exists"))
    return "An account with that email already exists. Sign in instead, or reset the password.";
  if (m.includes("password") && m.includes("least"))
    return "Password is too short — use at least 8 characters.";
  if (m.includes("rate limit") || m.includes("too many"))
    return "Too many attempts in a row. Wait a minute, then try again.";
  if (m.includes("fetch") || m.includes("network"))
    return "Could not reach the auth server. Is Supabase running? Check NEXT_PUBLIC_SUPABASE_URL and retry.";
  return `${message}. If this keeps happening, check the Supabase logs.`;
}

export function AuthForm({ mode }: { mode: AuthMode }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/overview";
  const initialError = params.get("error");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(
    initialError ? explain(initialError) : undefined
  );
  const [done, setDone] = useState<string>();
  const c = COPY[mode];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
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
      setError(explain(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[12px] border border-line bg-bg1 p-6 sm:p-7">
      <h1 className="text-[24px] font-bold leading-[1.1] tracking-[-0.02em] text-ink">{c.title}</h1>
      <p className="mt-1.5 text-[14px] text-ink-mute">{c.body}</p>

      {done ? (
        <div className="mt-6 rounded-[10px] border border-line bg-bg2 p-4 text-[14px] leading-[1.6] text-ink-mute">
          {done}
          <div className="mt-3">
            <Link href="/login" className="text-signal hover:underline">
              Back to sign in
            </Link>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
          {mode === "signup" && (
            <Field label="Name" help="Shown on your changes and in the audit log.">
              <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </Field>
          )}
          {mode !== "reset" && (
            <Field label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
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
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={mode === "login" ? undefined : 8}
                required
              />
            </Field>
          )}

          {error && (
            <p role="alert" className="rounded-[8px] bg-err-dim px-3 py-2 text-[13px] leading-[1.5] text-err">
              {error}
            </p>
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
