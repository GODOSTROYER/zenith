"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { authPageUrl } from "@/lib/auth/oauth";
import { ArrowUpRight, Check, LoaderCircle, Plus } from "lucide-react";
import styles from "./waitlist.module.css";

const PROFESSIONS = ["Developer", "Founder", "Designer", "Student", "Cloud engineer"];
const FEATURES = ["Deploy my app", "See my architecture", "Control cloud costs", "Build with AI agents", "Work across clouds"];

export interface WaitlistJoinFormProps {
  email?: string;
  name?: string;
  emailReadOnly?: boolean;
  next?: string;
  onDone?: () => void;
  onDismiss?: () => void;
}

/** Email is the only required answer. Shared by the landing dialog and public page. */
export function WaitlistJoinForm({ email: initialEmail = "", name: initialName = "", emailReadOnly = false, next, onDone, onDismiss }: WaitlistJoinFormProps) {
  const id = useId();
  const [email, setEmail] = useState(initialEmail);
  const [name, setName] = useState(initialName);
  const [profession, setProfession] = useState("");
  const [customProfession, setCustomProfession] = useState("");
  const [features, setFeatures] = useState<string[]>([]);
  const [customFeature, setCustomFeature] = useState("");
  const [customizingFeature, setCustomizingFeature] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);
  const success = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (done) success.current?.focus({ preventScroll: true }); }, [done]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !event.currentTarget.reportValidity()) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ email: email.trim(), name: name.trim(), occupation: profession === "Other" ? customProfession.trim() : profession, features: [...features, ...(customizingFeature && customFeature.trim() ? [customFeature.trim()] : [])] }),
      });
      if (!response.ok) {
        if (response.status === 429) throw new Error("A few too many requests. Please try again in an hour.");
        if (response.status === 404 || response.status === 503) throw new Error("New requests are paused for a moment. Please try again later.");
        if (response.status === 400) throw new Error("Please check your email and answers, then try again.");
        throw new Error("We couldn’t save your request. Please try again.");
      }
      setDone(true);
      onDone?.();
    } catch (cause) {
      setError(cause instanceof Error && cause.name === "AbortError" ? "That took a little too long. Please check your connection and try again." : cause instanceof Error ? cause.message : "We couldn’t save your request. Please try again.");
    } finally {
      clearTimeout(timeout);
      request.current = null;
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (done) return <div className={styles.success} ref={success} tabIndex={-1} role="status" aria-live="polite">
    <span className={styles.successMark}><Check size={27} strokeWidth={1.6} aria-hidden="true" /></span>
    <h2>You’re on the list.</h2>
    <p>Your request has been received. Access opens in small batches.</p>
    <p className={styles.successNote}>Already joined? Your place is safe. Sending another request never moves you back.</p>
    <p className={styles.successNote}>Once you’re admitted, <Link href={authPageUrl("/login", next)}>sign in</Link> with the same email.</p>
    {onDismiss ? <button type="button" className={styles.submit} onClick={onDismiss}>Keep exploring <ArrowUpRight size={18} aria-hidden="true" /></button> : <Link className={styles.submit} href="/">Explore Zenith <ArrowUpRight size={18} aria-hidden="true" /></Link>}
  </div>;

  return <form className={styles.form} onSubmit={(event) => void submit(event)} aria-busy={busy || undefined}>
    <div className={styles.field}>
      <label htmlFor={`${id}-email`}>Email address <span className={styles.required}>Required</span></label>
      <input id={`${id}-email`} type="email" name="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" maxLength={254} required readOnly={emailReadOnly} autoComplete="email" inputMode="email" spellCheck={false} disabled={busy} aria-describedby={emailReadOnly ? `${id}-email-note` : undefined} />
      {emailReadOnly && <p id={`${id}-email-note`} className={styles.fieldNote}>Your invitation will be linked to this account.</p>}
    </div>
    <section className={styles.preferences} aria-labelledby={`${id}-preferences-title`} aria-describedby={`${id}-preferences-note`}>
      <div className={styles.preferenceHeading}><h3 id={`${id}-preferences-title`}>Make it yours</h3><span className={styles.optional}>Optional</span></div>
      <p id={`${id}-preferences-note`} className={styles.priorityNote}>Share a little about yourself to <strong>improve your chances of getting early access sooner.</strong></p>
      <div className={styles.preferenceBody}>
        <div className={styles.field}>
          <label htmlFor={`${id}-name`}>Your name <span>Optional</span></label>
          <input id={`${id}-name`} name="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="What should we call you?" autoComplete="name" maxLength={120} disabled={busy} />
        </div>
        <fieldset className={styles.choices} disabled={busy}>
          <legend>What do you do? <span>Optional</span></legend>
          <div className={styles.chips}>{[...PROFESSIONS, "Other"].map((item) => <button key={item} type="button" aria-pressed={profession === item} onClick={() => setProfession(profession === item ? "" : item)}>{item}{profession === item && <Check size={12} aria-hidden="true" />}</button>)}</div>
          {profession === "Other" && <div className={`${styles.field} ${styles.customField}`}><label htmlFor={`${id}-profession`}>Your profession</label><input id={`${id}-profession`} name="occupation" value={customProfession} onChange={(event) => setCustomProfession(event.target.value)} placeholder="Tell us in your own words" maxLength={120} autoComplete="organization-title" /></div>}
        </fieldset>
        <fieldset className={styles.choices} disabled={busy}>
          <legend>What brings you to Zenith? <span>Pick any · Optional</span></legend>
          <div className={styles.featureGrid}>
            {FEATURES.map((item) => <label key={item} className={styles.feature}><input type="checkbox" checked={features.includes(item)} onChange={(event) => setFeatures(event.target.checked ? [...features, item] : features.filter((feature) => feature !== item))} /><span className={styles.checkbox}><Check size={12} aria-hidden="true" /></span><span>{item}</span></label>)}
            <button type="button" className={styles.customFeature} aria-expanded={customizingFeature} aria-controls={customizingFeature ? `${id}-custom-feature` : undefined} onClick={() => setCustomizingFeature(!customizingFeature)}><Plus size={15} aria-hidden="true" />Something else</button>
          </div>
          {customizingFeature && <div className={`${styles.field} ${styles.customField}`} id={`${id}-custom-feature`}><label htmlFor={`${id}-feature`}>Your idea</label><input id={`${id}-feature`} name="customFeature" value={customFeature} onChange={(event) => setCustomFeature(event.target.value)} placeholder="What would you love to do?" maxLength={120} /></div>}
        </fieldset>
      </div>
    </section>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <button type="submit" className={styles.submit} disabled={busy}>{busy ? <>Saving your place <LoaderCircle className={styles.spinner} size={18} aria-hidden="true" /></> : <>Join the waitlist <ArrowUpRight size={18} aria-hidden="true" /></>}</button>
    <p className={styles.privacy}>By joining, you agree to our <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>
  </form>;
}
