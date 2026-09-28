"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from "react";
import { SUGGESTION_DELAY_MS, canSuggest, initialLandingState, landingReducer, type ChapterId, type Highlight, type LandingAction, type LandingState } from "./landing-state";
import { SUGGESTIONS, WALKTHROUGHS, currentWalkthroughStep } from "./gimbal-guide";
import { useSmoothScroll } from "./landing-motion";

const StateContext = createContext<LandingState | null>(null);
const DispatchContext = createContext<Dispatch<LandingAction> | null>(null);

/** Session memory: which offers were made or declined, and whether Gimbal is quiet. */
const SESSION_KEY = "zenith-landing-guide";

/**
 * The page's shared presentation state, plus the two observers that feed it:
 * which chapter the visitor is in, and whether they have settled there long
 * enough for Gimbal to offer something. Nothing here reads mouse position or
 * infers intent; it reads scroll position, tab visibility and focus.
 */
export function LandingExperienceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(landingReducer, undefined, initialLandingState);
  useSmoothScroll();

  useEffect(() => {
    let saved: { offered?: string[]; dismissed?: string[]; quiet?: boolean; suggestionsShown?: number } = {};
    try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "{}") ?? {}; } catch { /* A page without session storage still works; Gimbal simply forgets on reload. */ }
    dispatch({ type: "restore", offered: saved.offered ?? [], dismissed: saved.dismissed ?? [], quiet: !!saved.quiet, suggestionsShown: saved.suggestionsShown ?? 0 });
  }, []);

  useEffect(() => {
    if (!state.restored) return;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ offered: state.offered, dismissed: state.dismissed, quiet: state.companion.quiet, suggestionsShown: state.suggestionsShown })); } catch { /* see above */ }
  }, [state.restored, state.offered, state.dismissed, state.companion.quiet, state.suggestionsShown]);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        <ChapterTracker state={state} dispatch={dispatch} />
        {children}
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useLanding(): { state: LandingState; dispatch: Dispatch<LandingAction> } {
  const state = useContext(StateContext);
  const dispatch = useContext(DispatchContext);
  if (!state || !dispatch) throw new Error("useLanding must be used inside LandingExperienceProvider.");
  return { state, dispatch };
}

/** The walkthrough emphasis that applies to one chapter right now. */
export function useHighlight(chapter: ChapterId): Highlight | null {
  const { state } = useLanding();
  return useMemo(() => {
    const step = currentWalkthroughStep(state);
    return step && step.chapter === chapter ? step.highlight(state) : null;
  }, [state, chapter]);
}

/** Start a walkthrough and bring its first chapter into view. */
export function useWalkthroughs() {
  const { dispatch } = useLanding();
  const start = useCallback((id: string) => {
    const walkthrough = WALKTHROUGHS[id];
    if (!walkthrough) return;
    dispatch({ type: "walkthrough-start", id });
    scrollToChapter(walkthrough.steps[0].chapter);
  }, [dispatch]);
  return { start };
}

export function scrollToChapter(chapter: ChapterId) {
  if (typeof document === "undefined") return;
  const target = document.querySelector<HTMLElement>(`[data-chapter="${chapter}"]`);
  if (!target) return;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}

const typing = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
};

/**
 * Reads which chapter owns the reading line (42% down the viewport) and how
 * long the visitor has been settled there with the tab visible, not typing,
 * not dragging and not already talking to Gimbal. One offer per chapter,
 * subject to the session rules in landing-state.ts.
 */
function ChapterTracker({ state, dispatch }: { state: LandingState; dispatch: Dispatch<LandingAction> }) {
  const latest = useRef(state);
  latest.current = state;
  const settled = useRef(0);
  const dragging = useRef(false);

  useEffect(() => {
    let frame: number | null = null;
    const read = () => {
      frame = null;
      const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-chapter]"));
      if (!sections.length) return;
      const line = window.innerHeight * 0.42;
      let current: ChapterId | null = null;
      for (const section of sections) {
        const rect = section.getBoundingClientRect();
        if (rect.top <= line && rect.bottom > line) { current = section.dataset.chapter as ChapterId; break; }
      }
      if (!current) {
        const first = sections[0].getBoundingClientRect();
        current = first.top > line ? (sections[0].dataset.chapter as ChapterId) : (sections[sections.length - 1].dataset.chapter as ChapterId);
      }
      if (current !== latest.current.chapter) { settled.current = 0; dispatch({ type: "chapter", chapter: current }); }
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(read); };
    read();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const down = () => { dragging.current = true; };
    const up = () => { dragging.current = false; };
    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    const tick = window.setInterval(() => {
      const s = latest.current;
      const section = document.querySelector<HTMLElement>(`[data-chapter="${s.chapter}"]`);
      const rect = section?.getBoundingClientRect();
      // Meaningfully visible: the chapter fills at least 45% of the viewport, or is fully on screen.
      const visibleHeight = rect ? Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0) : 0;
      const meaningful = !!rect && (visibleHeight >= window.innerHeight * 0.45 || (rect.top >= 0 && rect.bottom <= window.innerHeight));
      const eligible = meaningful && document.visibilityState === "visible" && !typing() && !dragging.current && !s.companion.open && !s.walkthrough && !s.suggestion && !s.companion.quiet && s.restored;
      settled.current = eligible ? settled.current + 1000 : 0;
      const suggestion = SUGGESTIONS[s.chapter];
      if (eligible && suggestion && settled.current >= SUGGESTION_DELAY_MS && canSuggest(s, suggestion, Date.now())) {
        settled.current = 0;
        dispatch({ type: "suggest", suggestion, now: Date.now() });
      }
    }, 1000);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.clearInterval(tick);
    };
  }, [dispatch]);

  return null;
}
