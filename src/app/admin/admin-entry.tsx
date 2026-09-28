"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUpRight, Orbit, ShieldCheck } from "lucide-react";
import { Wordmark } from "@/components/shell/wordmark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import theme from "./admin.module.css";
import styles from "./admin-entry.module.css";

export function AdminEntry({ accessDenied = false }: { accessDenied?: boolean }) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    const fields = new FormData(event.currentTarget);
    try {
      const { error: authError } = await createClient().auth.signInWithPassword({
        email: String(fields.get("email") ?? "").trim(),
        password: String(fields.get("password") ?? ""),
      });
      if (authError) {
        setError("Could not sign in. Check your email and password, then try again.");
      } else {
        inFlight.current = false;
        setBusy(false);
        router.replace("/admin");
        router.refresh();
        return;
      }
    } catch {
      setError("Connection interrupted. Please try again.");
    }
    inFlight.current = false;
    setBusy(false);
  }

  return (
    <div className={`${theme.theme} ${styles.entry}`}>
      <header className={styles.header}>
        <Link href="/" aria-label="Zenith home"><Wordmark size={26} /></Link>
        <span><ShieldCheck size={14} aria-hidden="true" /> Owner access</span>
      </header>
      <main className={styles.main}>
        <section className={styles.story} aria-labelledby="admin-welcome">
          <div className={styles.orbits} aria-hidden="true"><span /><span /><div><Orbit size={60} strokeWidth={1} /></div><i /></div>
          <span className={styles.eyebrow}>ZENITH / MISSION CONTROL</span>
          <h1 id="admin-welcome">Big ideas.<br />Small crew.<br /><em>Your orbit.</em></h1>
          <p>Every great launch starts somewhere.<br />This one starts with you.</p>
          <span className={styles.annotation}>GROUND CONTROL, MINUS THE HEADSET.</span>
        </section>
        <section className={styles.login} aria-labelledby="admin-signin">
          <span className={styles.eyebrow}>01 / IDENTIFY YOURSELF</span>
          <h2 id="admin-signin">{accessDenied ? "Owner access required." : <>Welcome back, <br />commander.</>}</h2>
          {accessDenied ? (
            <div className={styles.denied} role="alert">
              <p>This account cannot open mission control. Sign in with the owner account below, or sign out to start over.</p>
              <form action="/auth/signout" method="post">
                <input type="hidden" name="next" value="/admin" />
                <Button type="submit" variant="ghost" disabled={busy}>Sign out</Button>
              </form>
            </div>
          ) : <p>Sign in to manage early access to Zenith.</p>}
          <form onSubmit={signIn} aria-busy={busy}>
            <label htmlFor="admin-email">Email address</label>
            <Input id="admin-email" name="email" type="email" autoComplete="username" required disabled={busy} />
            <div className={styles.passwordLabel}><label htmlFor="admin-password">Password</label><Link href="/forgot-password?next=%2Fadmin">Forgot password?</Link></div>
            <Input id="admin-password" name="password" type="password" autoComplete="current-password" required disabled={busy} />
            {error && <p className={styles.error} role="alert">{error}</p>}
            <Button type="submit" variant="primary" block busy={busy}>Enter mission control <ArrowRight size={16} aria-hidden="true" /></Button>
          </form>
          <p className={styles.accessNote}><ShieldCheck size={14} aria-hidden="true" /> Authorized owners only. Good taste is not a credential.</p>
        </section>
      </main>
      <footer className={styles.footer}>
        <span>Built by <a href="https://www.arnavbule.in" target="_blank" rel="noopener noreferrer">Arnav Bule <ArrowUpRight size={12} aria-hidden="true" /></a>. A little ambition. A lot of orbit.</span>
        <a href="https://github.com/GODOSTROYER" target="_blank" rel="noopener noreferrer">GODOSTROYER on GitHub <ArrowUpRight size={12} aria-hidden="true" /></a>
      </footer>
    </div>
  );
}
