"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { api } from "@/lib/client/api";
import { mfaReturnPath } from "@/lib/auth/mfa-navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Factor = { id: string; friendly_name?: string };
type Enrollment = { id: string; secret: string; qr: string };
const FAILURE = "Your authenticator could not be verified. Check the code and try again, or sign in again if your session ended.";

export function MfaFlow({ mode, returnTo }: { mode: "enrol" | "challenge"; returnTo?: string }) {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [factorId, setFactorId] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const successRef = useRef<HTMLHeadingElement>(null);
  // A synchronous latch covers two submit events in the same React commit.
  const pending = useRef(false);
  const destination = mfaReturnPath(returnTo);

  useEffect(() => {
    let active = true;
    if (!isSupabaseConfigured()) {
      setError("Authentication is unavailable. Privileged actions require a verified authenticator.");
      setBusy(false);
      return;
    }
    void (async () => {
      try {
        const client = createClient();
        const identity = await client.auth.getUser();
        if (identity.error || !identity.data.user) throw new Error();
        const answer = await client.auth.mfa.listFactors();
        if (answer.error) throw new Error();
        if (!active) return;
        const verified = answer.data.totp.filter((factor) => factor.status === "verified");
        setFactors(verified);
        setFactorId(verified[0]?.id ?? "");
        setReady(true);
      } catch { if (active) setError("We could not check your authenticators. Sign in again, then reload this page."); }
      finally { if (active) setBusy(false); }
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => { if (error) alertRef.current?.focus(); }, [error]);
  useEffect(() => { if (success) successRef.current?.focus(); }, [success]);
  useEffect(() => { if (ready && (mode === "challenge" || enrollment)) codeRef.current?.focus(); }, [ready, mode, enrollment]);

  async function enrol() {
    if (pending.current || !ready) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await createClient().auth.mfa.enroll({ factorType: "totp", issuer: "Zenith", friendlyName: `Zenith ${new Date().toISOString()}` });
      if (result.error) throw new Error();
      setEnrollment({ id: result.data.id, secret: result.data.totp.secret, qr: result.data.totp.qr_code });
      setFactorId(result.data.id);
    } catch { setError("Authenticator setup could not start. Reload and try again."); }
    finally { pending.current = false; setBusy(false); }
  }

  async function cancelEnrollment() {
    if (pending.current || !enrollment) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await createClient().auth.mfa.unenroll({ factorId: enrollment.id });
      if (result.error) throw new Error();
      setEnrollment(undefined); setFactorId(factors[0]?.id ?? ""); setCode("");
    } catch { setError("Setup could not be cancelled. Reload to check your authenticators before trying again."); }
    finally { pending.current = false; setBusy(false); }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !ready || !factorId || !/^\d{6}$/.test(code)) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await createClient().auth.mfa.challengeAndVerify({ factorId, code });
      setCode("");
      if (result.error) throw new Error();
      if (enrollment) {
        setFactors((existing) => [...existing, { id: enrollment.id, friendly_name: "Zenith authenticator" }]);
        setEnrollment(undefined);
      }
      // SDK writes the promoted session cookie; the server must independently accept it.
      const proof = await api<{ verified: boolean }>("/api/auth/mfa/verify", { method: "GET", credentials: "same-origin" });
      if (proof.verified !== true) throw new Error();
      setSuccess(true);
    } catch { setCode(""); setError(FAILURE); }
    finally { pending.current = false; setBusy(false); }
  }

  return <section aria-labelledby="mfa-title" className="mx-auto max-w-xl space-y-5 p-6">
    <h1 id="mfa-title" className="app-page-title">{mode === "enrol" ? "Set up an authenticator" : "Verify your authenticator"}</h1>
    <p>Privileged actions require a second factor. Verification lets you return to the review; you submit the action yourself.</p>
    {busy && <p role="status">{ready ? "Verifying with the identity provider…" : "Checking your authenticators…"}</p>}
    {error && <p ref={alertRef} role="alert" tabIndex={-1}>{error}</p>}
    {success ? <>
      <h2 ref={successRef} tabIndex={-1}>Authenticator verified</h2>
      <p>Review the current plan and workspace before submitting your action.</p>
      <Link className="text-signal underline" href={destination}>Return to review</Link>
    </> : <>
      {ready && mode === "enrol" && !enrollment && <>
        <Button variant="primary" busy={busy} onClick={() => void enrol()}>Set up authenticator</Button>
        {factors.length > 0 && <p>You already have an authenticator. <Link href={`/account/mfa/challenge?next=${encodeURIComponent(destination)}`} className="text-signal underline">Verify an existing authenticator</Link>.</p>}
      </>}
      {enrollment && <>
        <p>Scan this code in your authenticator app, or enter the setup key manually. Keep the key private.</p>
        {/* Supabase returns an SVG data URL. Never inject provider markup as HTML. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={enrollment.qr} alt="Authenticator setup QR code. The setup key is also available below." width={220} height={220} />
        <label htmlFor="mfa-setup-key">Setup key</label>
        <Input id="mfa-setup-key" readOnly autoComplete="off" value={enrollment.secret} mono className="w-full" />
        <Button busy={busy} onClick={() => void cancelEnrollment()}>Cancel setup</Button>
      </>}
      {ready && mode === "challenge" && factors.length === 0 && <p>No verified authenticator is enrolled. <Link href={`/account/mfa/enrol?next=${encodeURIComponent(destination)}`} className="text-signal underline">Set up an authenticator</Link>.</p>}
      {ready && (enrollment || (mode === "challenge" && factors.length > 0)) && <form onSubmit={(event) => void verify(event)} className="space-y-3">
        {!enrollment && <><label htmlFor="mfa-factor">Authenticator</label><select id="mfa-factor" value={factorId} disabled={busy} onChange={(event) => setFactorId(event.target.value)} className="h-9 w-full rounded-ctl border border-line bg-bg1 px-3 text-ink focus-visible:outline-2 focus-visible:outline-signal">
          {factors.map((factor, index) => <option key={factor.id} value={factor.id}>{factor.friendly_name || `Authenticator ${index + 1}`}</option>)}
        </select></>}
        <label htmlFor="mfa-code">Six-digit authenticator code</label>
        <p id="mfa-code-help">Enter the current code from your authenticator app.</p>
        <Input ref={codeRef} id="mfa-code" aria-describedby="mfa-code-help" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} disabled={busy} onChange={(event) => setCode(event.target.value)} className="w-full" />
        <Button type="submit" busy={busy} disabled={!/^\d{6}$/.test(code)} disabledReason="Enter the six-digit code from your authenticator." variant="primary">Verify authenticator</Button>
      </form>}
    </>}
    <Link href="/account" className="text-signal underline">Back to account</Link>
  </section>;
}
