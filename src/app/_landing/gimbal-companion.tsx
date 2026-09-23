"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { GLASS, useLiquidGlass } from "./liquid-glass";
import { ArrowUpRight, BellOff, Minus, RotateCcw, X } from "lucide-react";
import { GimbalCharacter } from "@/components/navigator/gimbal-character";
import type { GimbalMood } from "@/components/navigator/gimbal-renderer";
import { SUGGESTION_TTL_MS } from "./landing-state";
import { CHAPTER_TOPICS, NO_ANSWER, WALKTHROUGHS, contextLine, currentWalkthroughStep, matchTopic, moodForAutonomy, topicById, type Topic } from "./gimbal-guide";
import { scrollToChapter, useLanding, useWalkthroughs } from "./landing-experience";
import { PromptBar } from "./prompt-bar";
import styles from "./gimbal-companion.module.css";

type Exchange = { id: number; question: string; topic: Topic | null };
const INVITE_ID = "hero-invite";

/**
 * Gimbal, at home in the bottom-right corner.
 *
 * The character is the product's own renderer with a personality mood on top.
 * The invitation, the offer bubble, the walkthrough callout and the guide
 * panel open beside it; the character itself never sits in a card. Everything
 * it says comes from the curated guide and the shared page state, and nothing
 * it does can execute a real action.
 */
export function GimbalCompanion() {
  const { state, dispatch } = useLanding();
  const { start } = useWalkthroughs();
  const { companion, suggestion, walkthrough } = state;
  const [transient, setTransient] = useState<GimbalMood | null>(null);
  const transientTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovering, setHovering] = useState(false);
  const [closing, setClosing] = useState(false);
  const [onHero, setOnHero] = useState(true);
  const [shownOnce, setShownOnce] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mobile, setMobile] = useState(false);
  const [draft, setDraft] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const nextId = useRef(0);
  const launcher = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const callout = useRef<HTMLDivElement>(null);
  const shine = useRef<number | null>(null);
  /* The glass catches the pointer's light: two custom properties, written straight to the element once a frame. */
  const followLight = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse" || shine.current !== null) return;
    const target = event.currentTarget;
    const { clientX, clientY } = event;
    shine.current = requestAnimationFrame(() => {
      shine.current = null;
      const box = target.getBoundingClientRect();
      if (!box.width || !box.height) return;
      target.style.setProperty("--px", `${(((clientX - box.left) / box.width) * 100).toFixed(1)}%`);
      target.style.setProperty("--py", `${(((clientY - box.top) / box.height) * 100).toFixed(1)}%`);
    });
  }, []);
  const restLight = useCallback((event: PointerEvent<HTMLElement>) => {
    event.currentTarget.style.removeProperty("--px");
    event.currentTarget.style.removeProperty("--py");
  }, []);
  useEffect(() => () => { if (shine.current !== null) cancelAnimationFrame(shine.current); }, []);
  const conversation = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const panelId = useId();

  /** A short-lived expression that settles back into the base mood. */
  const pulse = useCallback((mood: GimbalMood, ms = 2200) => {
    if (transientTimer.current) clearTimeout(transientTimer.current);
    setTransient(mood);
    transientTimer.current = setTimeout(() => { setTransient(null); transientTimer.current = null; }, ms);
  }, []);
  useEffect(() => () => { if (transientTimer.current) clearTimeout(transientTimer.current); }, []);

  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 640px)");
    if (!media) return;
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  /* Reactions to what the visitor does elsewhere on the page. */
  const first = useRef(true);
  useEffect(() => { if (first.current) return; pulse(moodForAutonomy(state.autonomy), 2600); }, [state.autonomy, pulse]);
  useEffect(() => { if (first.current) return; pulse(state.scale === 3 ? "cautious" : state.scale === 0 ? "attentive" : "delighted", state.scale === 3 ? 3200 : 1800); }, [state.scale, pulse]);
  useEffect(() => { if (first.current) return; pulse(state.view === "proposed" ? "engaged" : "attentive", 1500); }, [state.view, pulse]);
  useEffect(() => { first.current = false; }, []);

  /* Gimbal keeps out of the opening: it rises into its corner once the sky has scrolled past. */
  useEffect(() => {
    const edge = document.querySelector<HTMLElement>("[data-sheet-edge]");
    if (!edge) { setOnHero(false); return; }
    // Shown once the sheet's edge has risen into the upper third of the viewport. Measured on scroll rather than
    // observed, so an instant jump (a hash, a "See the system" link) can never skip the crossing.
    let frame: number | null = null;
    const measure = () => { frame = null; setOnHero(edge.getBoundingClientRect().top > window.innerHeight * 0.34); };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => { if (frame !== null) cancelAnimationFrame(frame); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, []);
  const step = currentWalkthroughStep(state);
  const definition = walkthrough ? WALKTHROUGHS[walkthrough.id] : null;
  const base: GimbalMood = step ? (step.mood ?? "engaged") : companion.open ? "attentive" : suggestion || hovering ? "attentive" : "idle";
  const mood = transient ?? base;
  const tempo = companion.open || hovering || step ? 2.6 : 1.9;
  const hidden = onHero && !companion.open && !closing && !walkthrough;
  useEffect(() => { if (!hidden) setShownOnce(true); }, [hidden]);
  // Liquid glass for the guide and its pop-outs; each reads what it floats over and sets its text tone to contrast.
  useLiquidGlass(panel, GLASS.panel, { active: companion.open, tone: true });
  useLiquidGlass(callout, GLASS.bubble, { active: Boolean(!companion.open && step && definition && walkthrough), tone: true });
  useLiquidGlass(bubble, GLASS.bubble, { active: Boolean(!companion.open && !walkthrough && suggestion), tone: true });
  useEffect(() => { if (companion.mood !== mood) dispatch({ type: "mood", mood }); }, [mood, companion.mood, dispatch]);

  /* Open, close and focus. */
  const open = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setClosing(false);
    dispatch({ type: "companion-open" });
    pulse("engaged", 1800);
  }, [dispatch, pulse]);
  const focusLauncher = () => launcher.current?.querySelector<HTMLButtonElement>(".gimbal-greeting")?.focus({ preventScroll: true });
  /* The panel leaves with a short beat of its own before it unmounts; under a reduced-motion preference it simply goes. */
  const close = useCallback(() => {
    const finish = () => { closeTimer.current = null; setClosing(false); dispatch({ type: "companion-close" }); setTimeout(focusLauncher, 0); };
    const animated = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: no-preference)")?.matches === true;
    if (!animated || closeTimer.current) { if (!closeTimer.current) finish(); return; }
    setClosing(true);
    closeTimer.current = setTimeout(finish, 260);
  }, [dispatch]);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useLayoutEffect(() => {
    if (!companion.open) return;
    const coarse = window.matchMedia?.("(pointer: coarse)").matches;
    (coarse ? panel.current : input.current)?.focus({ preventScroll: true });
  }, [companion.open]);
  useEffect(() => {
    if (companion.open && conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [companion.open, exchanges]);
  useEffect(() => {
    if (!companion.open && !walkthrough && !suggestion) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (companion.open) { event.preventDefault(); close(); }
      else if (walkthrough) { dispatch({ type: "walkthrough-end" }); pulse("pleased", 1600); focusLauncher(); }
      else if (suggestion) dispatch({ type: "suggestion-dismiss" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [companion.open, walkthrough, suggestion, close, dispatch, pulse]);

  /* On phones the sheet is modal: the page behind it holds still and focus stays inside. */
  useEffect(() => {
    if (!companion.open || !mobile) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const contain = (event: FocusEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target)) panel.current?.focus(); };
    document.addEventListener("focusin", contain);
    return () => { document.body.style.overflow = previous; document.removeEventListener("focusin", contain); };
  }, [companion.open, mobile]);
  const trapTab = (event: KeyboardEvent<HTMLElement>) => {
    if (!mobile || event.key !== "Tab") return;
    const focusable = Array.from(panel.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? []);
    const firstEl = focusable[0], lastEl = focusable.at(-1);
    if (!firstEl || !lastEl) { event.preventDefault(); panel.current?.focus(); return; }
    if (event.shiftKey && (document.activeElement === firstEl || document.activeElement === panel.current)) { event.preventDefault(); lastEl.focus(); }
    else if (!event.shiftKey && (document.activeElement === lastEl || document.activeElement === panel.current)) { event.preventDefault(); firstEl.focus(); }
  };

  /* An ignored bubble leaves on its own; a focused one waits. */
  useEffect(() => {
    if (!suggestion) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      if (bubble.current?.contains(document.activeElement)) { timer = setTimeout(expire, SUGGESTION_TTL_MS); return; }
      dispatch({ type: "suggestion-expire" });
    };
    timer = setTimeout(expire, SUGGESTION_TTL_MS);
    return () => clearTimeout(timer);
  }, [suggestion, dispatch]);

  /* Walkthrough steps follow their chapter into view. */
  useEffect(() => { if (step) scrollToChapter(step.chapter); }, [step]);

  const send = (text = draft) => {
    const question = text.trim().slice(0, 500);
    if (!question) return;
    const topic = matchTopic(question);
    setExchanges((previous) => [...previous.slice(-11), { id: nextId.current++, question, topic }]);
    setDraft("");
    dispatch({ type: "companion-topic", topic: topic?.id ?? null, question });
    pulse(topic ? (topic.mood ?? "engaged") : "cautious", 1800);
  };
  const chooseTopic = (topic: Topic) => {
    setExchanges((previous) => [...previous.slice(-11), { id: nextId.current++, question: topic.question, topic }]);
    dispatch({ type: "companion-topic", topic: topic.id, question: null });
    pulse(topic.mood ?? "engaged", 1600);
  };
  const showMe = (topic: Topic) => {
    if (!topic.show) return;
    close();
    if (topic.show.walkthrough) start(topic.show.walkthrough); else scrollToChapter(topic.show.chapter);
  };
  const renderAnswer = (topic: Topic | null) => topic ? <>
    <p>{topic.answer}</p>
    {topic.more && <p>{topic.more}</p>}
    {topic.show && <button type="button" className={styles.showMe} onClick={() => showMe(topic)}>{topic.show.label} <ArrowUpRight size={14} aria-hidden="true" /></button>}
  </> : <p>{NO_ANSWER}</p>;

  const intro = topicById("what-is-zenith");
  const asked = new Set(exchanges.map((e) => e.topic?.id));
  const chips = CHAPTER_TOPICS[state.chapter].map(topicById).filter((t): t is Topic => !!t && !asked.has(t.id));
  const invited = state.restored && state.chapter === "hero" && !companion.open && !suggestion && !walkthrough && !companion.quiet && !state.dismissed.includes(INVITE_ID) && !state.offered.includes(INVITE_ID);
  const nextStep = () => {
    if (!walkthrough || !definition) return;
    if (walkthrough.step + 1 >= definition.steps.length) { dispatch({ type: "walkthrough-end" }); pulse("pleased", 2000); focusLauncher(); }
    else dispatch({ type: "walkthrough-step", step: walkthrough.step + 1 });
  };

  if (companion.minimized) {
    return (
      <div className={`zenith-ink-tokens ${styles.companion}`} data-mood="idle">
        <button type="button" className={styles.restore} onClick={() => dispatch({ type: "companion-minimize", minimized: false })} aria-label="Show Gimbal"><RotateCcw size={14} aria-hidden="true" />Restore Gimbal</button>
      </div>
    );
  }

  return (
    <div className={`zenith-ink-tokens ${styles.companion}`} data-mood={mood} data-open={companion.open || undefined} data-hidden={hidden || undefined} data-glass-skip>
      {companion.open && mobile && <div className={styles.scrim} data-closing={closing || undefined} aria-hidden="true" onClick={close} />}
      {companion.open && (
        <section ref={panel} className={styles.panel} data-closing={closing || undefined} data-tone="dark" role="dialog" aria-modal={mobile || undefined} aria-label="Ask Gimbal" aria-describedby={`${panelId}-kind`} tabIndex={-1} onKeyDown={trapTab} onPointerMove={followLight} onPointerLeave={restLight}>
          <header className={styles.header}>
            <div><h2 id={`${panelId}-title`}>A little perspective.</h2><span id={`${panelId}-kind`} className={styles.guideLabel}>Ask Gimbal · Answers from the Zenith team</span></div>
            <div className={styles.actions}>
              <button type="button" aria-pressed={companion.quiet} aria-label={companion.quiet ? "Quiet mode on" : "Quiet mode off"} title={companion.quiet ? "Quiet mode is on: no unprompted suggestions" : "Turn on quiet mode: no unprompted suggestions"} onClick={() => dispatch({ type: "companion-quiet", quiet: !companion.quiet })}><BellOff size={16} aria-hidden="true" /></button>
              <button type="button" aria-label="Minimize Gimbal" title="Minimize Gimbal" onClick={() => dispatch({ type: "companion-minimize", minimized: true })}><Minus size={17} aria-hidden="true" /></button>
              <button type="button" aria-label="Close" title="Close" onClick={close}><X size={17} aria-hidden="true" /></button>
            </div>
          </header>
          <div className={styles.context}><span className={styles.contextDot} />You’re looking at <strong>{contextLine(state)}</strong></div>
          <div ref={conversation} className={styles.conversation} role="log" aria-label="Conversation with Gimbal" aria-live="polite" aria-relevant="additions">
            {exchanges.length === 0 && <div className={styles.answer}>{renderAnswer(intro)}</div>}
            {exchanges.map((exchange) => <div key={exchange.id} className={styles.exchange}>
              <p className={styles.question}><span className={styles.srOnly}>You: </span>{exchange.question}</p>
              <div className={styles.answer}><span className={styles.srOnly}>Gimbal: </span>{renderAnswer(exchange.topic)}</div>
            </div>)}
          </div>
          <div className={styles.chips} aria-label="Questions for this chapter">{chips.map((topic) => <button key={topic.id} type="button" onClick={() => chooseTopic(topic)}>{topic.question}</button>)}</div>
          <div className={styles.composer}><PromptBar id={`${panelId}-prompt`} label="Ask Gimbal a question" sendLabel="Send question" placeholder="What would you like to know?" value={draft} onValueChange={setDraft} onSend={() => send()} maxLength={500} inputRef={input} /></div>
        </section>
      )}
      {!companion.open && step && definition && walkthrough && (
        <div ref={callout} className={styles.callout} data-tone="dark" role="dialog" aria-label={`Walkthrough: ${definition.title}`}>
          <div className={styles.calloutHead}><span>{definition.title} · {walkthrough.step + 1} / {definition.steps.length}</span><button type="button" className={styles.closeSmall} aria-label="Close walkthrough" onClick={() => { dispatch({ type: "walkthrough-end" }); pulse("pleased", 1400); }}><X size={16} aria-hidden="true" /></button></div>
          <p aria-live="polite">{step.text(state)}</p>
          <div className={styles.bubbleActions}>
            <button type="button" className={styles.step} disabled={walkthrough.step === 0} onClick={() => dispatch({ type: "walkthrough-step", step: walkthrough.step - 1 })}>Back</button>
            <button type="button" className={styles.accept} onClick={nextStep}>{walkthrough.step + 1 >= definition.steps.length ? "Done" : "Next"}</button>
          </div>
        </div>
      )}
      {!companion.open && !walkthrough && suggestion && (
        <div ref={bubble} className={styles.bubble} data-tone="dark" role="status" aria-live="polite">
          <p>{suggestion.prompt}</p>
          <div className={styles.bubbleActions}>
            <button type="button" className={styles.dismiss} onClick={() => dispatch({ type: "suggestion-dismiss" })}>Not now</button>
            <button type="button" className={styles.accept} onClick={() => { dispatch({ type: "suggestion-accept" }); pulse("delighted", 1800); }}>{suggestion.accept}</button>
          </div>
        </div>
      )}
      <div ref={launcher} className={styles.launcher} onPointerEnter={(event) => { if (event.pointerType === "mouse") setHovering(true); }} onPointerLeave={() => setHovering(false)}>
        {invited && (
          <div className={styles.invitation}>
            <button type="button" className={styles.invitationText} onClick={() => { dispatch({ type: "suggest", suggestion: { id: INVITE_ID, chapter: "hero", prompt: "", accept: "", walkthrough: "overview" }, now: Date.now() }); dispatch({ type: "suggestion-accept" }); pulse("delighted", 1800); }}>Let me show you around <ArrowUpRight size={14} aria-hidden="true" /></button>
            <button type="button" className={styles.dismissInvitation} aria-label="Dismiss Gimbal invitation" onClick={() => { dispatch({ type: "suggest", suggestion: { id: INVITE_ID, chapter: "hero", prompt: "", accept: "", walkthrough: "overview" }, now: 0 }); dispatch({ type: "suggestion-dismiss" }); }}><X size={13} aria-hidden="true" /></button>
          </div>
        )}
        <div className={styles.stage}>
          <div className={styles.float}>
            <span className={styles.halo} aria-hidden="true" />
            <span className={styles.core} aria-hidden="true" />
            <div className={styles.character}>
              {(shownOnce || !hidden) && <GimbalCharacter state={null} material="porcelain" mood={mood} tempo={tempo} activateLabel={companion.open ? "Close Gimbal" : "Ask Gimbal"} onActivate={() => { if (companion.open) close(); else open(); }} />}
            </div>
          </div>
          <span className={styles.shadow} aria-hidden="true" />
        </div>
        {!companion.open && <span className={styles.launcherLabel} aria-hidden="true">Ask Gimbal</span>}
      </div>
    </div>
  );
}
