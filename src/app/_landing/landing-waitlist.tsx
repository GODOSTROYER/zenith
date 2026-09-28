"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { OrbitMark } from "@/components/shell/wordmark";
import { WaitlistJoinForm } from "@/app/waitlist/waitlist-join-form";
import formStyles from "@/app/waitlist/waitlist.module.css";
import { useLanding } from "./landing-experience";
import styles from "./landing-waitlist.module.css";

/** The desktop hero and mobile masthead share this modal, with a real standalone href fallback. */
export function LandingWaitlist({ signedIn = false }: { signedIn?: boolean }) {
  const { dispatch } = useLanding();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [joined, setJoined] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const show = useCallback((element: HTMLElement) => {
    trigger.current = element;
    dispatch({ type: "companion-close" });
    dispatch({ type: "walkthrough-end" });
    setOpen(true);
  }, [dispatch]);
  const close = useCallback(() => {
    if (closeTimer.current) return;
    const finish = () => {
      closeTimer.current = null;
      dialog.current?.close();
      setOpen(false);
      setClosing(false);
    };
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) finish();
    else { setClosing(true); closeTimer.current = setTimeout(finish, 220); }
  }, []);

  // Capture before Next's Link handler. Modified clicks and real hrefs still open the standalone page.
  useEffect(() => {
    if (signedIn) return;
    const intercept = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.zenith-landing a[data-waitlist-trigger][href="/waitlist"], .zenith-landing [data-chapter="hero"] a[href="/waitlist"]') : null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      event.preventDefault();
      show(anchor);
    };
    document.addEventListener("click", intercept, true);
    return () => document.removeEventListener("click", intercept, true);
  }, [show, signedIn]);

  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current;
    element.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Native modal focus and inertness also protect against tabbing into the landing.
    // Focus the heading on touch devices so opening never forces the keyboard up.
    const focus = window.matchMedia?.("(pointer: coarse)").matches ? element.querySelector<HTMLElement>("[data-waitlist-title]") : element.querySelector<HTMLInputElement>('input[type="email"]');
    focus?.focus({ preventScroll: true });
    const viewport = window.visualViewport;
    const fit = () => { element.style.setProperty("--waitlist-viewport", `${viewport?.height ?? window.innerHeight}px`); element.style.setProperty("--waitlist-top", `${viewport?.offsetTop ?? 0}px`); };
    fit();
    viewport?.addEventListener("resize", fit);
    viewport?.addEventListener("scroll", fit);
    return () => {
      document.body.style.overflow = previousOverflow;
      viewport?.removeEventListener("resize", fit);
      viewport?.removeEventListener("scroll", fit);
      element.close();
      trigger.current?.focus({ preventScroll: true });
    };
  }, [open]);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  return <dialog ref={dialog} id={id} className={`${formStyles.surface} ${styles.dialog}`} data-closing={closing || undefined} aria-labelledby={`${id}-title`} aria-describedby={joined ? undefined : `${id}-description`} onCancel={(event) => { event.preventDefault(); close(); }} onClick={(event) => { if (event.target === event.currentTarget) close(); }} data-lenis-prevent>
      <div className={styles.window}>
        <div className={styles.windowTop}><OrbitMark size={24} /><span>EARLY ACCESS</span><button type="button" className={styles.close} onClick={close} aria-label="Close waitlist"><X size={18} aria-hidden="true" /></button></div>
        <div className={styles.windowBody}>
          {!joined && <div className={formStyles.intro}>
            <p className={formStyles.eyebrow}>A little closer to Zenith</p>
            <h2 id={`${id}-title`} className={formStyles.title} tabIndex={-1} data-waitlist-title>Your next<br /><em>great beginning.</em></h2>
            <p id={`${id}-description`} className={formStyles.description}>A clearer view of your cloud is coming. Leave your email for early access.</p>
          </div>}
          {joined && <span id={`${id}-title`} className="sr-only">Zenith waitlist</span>}
          <WaitlistJoinForm onDone={() => setJoined(true)} onDismiss={close} />
        </div>
      </div>
    </dialog>;
}
