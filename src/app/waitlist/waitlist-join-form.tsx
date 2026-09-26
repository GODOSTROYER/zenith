"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function WaitlistJoinForm({ email }: { email: string }) {
  const [occupation, setOccupation] = useState("");
  const [useCase, setUseCase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    if (!occupation.trim() || !useCase.trim()) {
      setError("Tell us your occupation and what you want to build.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, occupation: occupation.trim(), useCase: useCase.trim() }),
      });
      if (!response.ok) {
        if (response.status === 429) throw new Error("Too many requests right now. Please try again in an hour.");
        if (response.status === 404 || response.status === 503) throw new Error("New waitlist requests are currently paused. Please try again later.");
        throw new Error("Your request could not be saved. Please try again.");
      }
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your request could not be saved. Please try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="join-waitlist-heading" className="mt-10 rounded-card border border-line bg-bg1 p-5 sm:p-6">
      <h2 id="join-waitlist-heading" className="text-[16px] font-medium">Tell us what you&apos;re building</h2>
      {done ? <p role="status" className="mt-3 text-[14px] leading-relaxed text-ink-mute">Your request has been received. If you already joined, your place in the queue is preserved. Return here to check when your account has access.</p> : <>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-mute">Join the waitlist with this account&apos;s email. If you&apos;ve already joined, submitting again keeps your place.</p>
        <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-5">
          <Field label="Email" help="Admission applies to this verified email address."><Input type="email" name="email" value={email} readOnly autoComplete="email" /></Field>
          <Field label="What do you do?" required><Input name="occupation" value={occupation} onChange={(event) => setOccupation(event.target.value)} placeholder="e.g. Founder, software engineer, student" maxLength={120} required disabled={busy} /></Field>
          <Field label="What would you use Zenith for?" required><Textarea name="useCase" value={useCase} onChange={(event) => setUseCase(event.target.value)} placeholder="Tell us about the project or workflow you have in mind." maxLength={2000} required rows={4} disabled={busy} /></Field>
          {error && <p role="alert" className="text-[13px] text-err">{error}</p>}
          <Button type="submit" variant="primary" busy={busy}>Join the waitlist</Button>
        </form>
      </>}
    </section>
  );
}
