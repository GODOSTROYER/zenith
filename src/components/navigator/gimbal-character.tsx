"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "@/lib/format";
import type { GimbalState } from "./gimbal-contract";
import type { GimbalMaterial, GimbalMood, GimbalRenderer } from "./gimbal-renderer";
import { GimbalFallback } from "./gimbal-fallback";

/** Visible-only gyroscope. Workflow information remains in adjacent HTML. */
export function GimbalCharacter({ state, material = "alloy", mood = "idle", tempo = 1, className, activateLabel, onActivate }: {
  state: GimbalState | null;
  material?: GimbalMaterial;
  /** Personality only: pace and expression. Never a workflow or verification signal. */
  mood?: GimbalMood;
  /** Multiplies the rings' orbit rate on top of state and mood; 1 is the product's own pace. */
  tempo?: number;
  className?: string;
  /** Accessible name of the character's button; defaults to the greeting. */
  activateLabel?: string;
  /** When present, activating the character calls this instead of showing the greeting text. */
  onActivate?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<GimbalRenderer | null>(null);
  const latestState = useRef(state);
  const latestMood = useRef(mood);
  const latestTempo = useRef(tempo);
  const syncSettings = useRef<() => void>(() => {});
  const greetingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hello, setHello] = useState(false);
  const [active, setActive] = useState(false);
  const [ready, setReady] = useState(false);
  latestState.current = state;
  latestMood.current = mood;
  latestTempo.current = tempo;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    setReady(false);
    let starting = false;
    let visible = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const reducedMotion = () => preference.matches;
    syncSettings.current = () => {
      renderer.current?.setReducedMotion(reducedMotion());
    };

    const recover = () => {
      if (disposed) return;
      setReady(false);
      renderer.current?.dispose();
      renderer.current = null;
      starting = false;
      // One retry per mount; persistent GPU failures retain the usable SVG.
      if (attempts < 2 && retryTimer === undefined)
        retryTimer = setTimeout(() => { retryTimer = undefined; syncVisibility(); }, 1200);
    };

    const syncVisibility = () => {
      const active = visible && document.visibilityState === "visible";
      setActive(active);
      renderer.current?.setVisible(active);
      if (!active || starting || renderer.current || attempts >= 2 || retryTimer !== undefined) return;
      starting = true;
      attempts += 1;
      // Keep the Three.js renderer out of the server compilation graph.
      if (typeof window === "undefined") return;
      void import("./gimbal-renderer").then(async ({ createGimbalRenderer }) => {
        if (disposed) return;
        // Visibility can change while the module loads. Defer GPU creation until
        // the next visible observation without consuming a recovery attempt.
        if (!visible || document.visibilityState !== "visible") { starting = false; attempts -= 1; return; }
        let failed = false;
        const instance = await createGimbalRenderer(element, {
          state: latestState.current,
          mood: latestMood.current,
          tempo: latestTempo.current,
          material,
          reducedMotion: reducedMotion(),
          onReady: () => { if (!disposed) setReady(true); },
          onError: () => { failed = true; recover(); },
        });
        if (disposed || failed) { instance.dispose(); return; }
        renderer.current = instance;
        starting = false;
        instance.setState(latestState.current);
        instance.setMood(latestMood.current);
        instance.setTempo(latestTempo.current);
        syncSettings.current();
        instance.setVisible(visible && document.visibilityState === "visible");
      }).catch(recover);
    };

    const bounds = element.getBoundingClientRect();
    visible = bounds.bottom > 0 && bounds.top < window.innerHeight && bounds.width > 0;
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      syncVisibility();
    });
    observer.observe(element);
    const changeMotion = () => syncSettings.current();
    preference.addEventListener("change", changeMotion);
    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      if (greetingTimer.current) clearTimeout(greetingTimer.current);
      syncSettings.current = () => {};
      observer.disconnect();
      preference.removeEventListener("change", changeMotion);
      document.removeEventListener("visibilitychange", syncVisibility);
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [material]);

  useLayoutEffect(() => { renderer.current?.setState(state); }, [state]);
  useLayoutEffect(() => { renderer.current?.setMood(mood); }, [mood]);
  useLayoutEffect(() => { renderer.current?.setTempo(tempo); }, [tempo]);

  const greet = () => {
    if (onActivate) {
      renderer.current?.greet("tap");
      onActivate();
      return;
    }
    if (greetingTimer.current) return;
    renderer.current?.greet("tap");
    setHello(true);
    greetingTimer.current = setTimeout(() => { setHello(false); greetingTimer.current = null; }, 1800);
  };
  const label = activateLabel ?? "Say hello to Gimbal";

  return (
    <div className={cx("gimbal-character", className)} data-gimbal-state={state ?? "neutral"} data-gimbal-mood={mood}
      data-renderer={ready ? "3d" : "static"} data-quality="max" data-material={material} data-active={active}>
      <span className="gimbal-aura" aria-hidden="true" />
      <span key={state} className="gimbal-state-pulse" aria-hidden="true" />
      <GimbalFallback state={state} material={material} mood={mood} hidden={ready} />
      <div className="gimbal-canvas" ref={host} aria-hidden="true" />
      <button type="button" className="gimbal-greeting" aria-label={label}
        title={label}
        onPointerEnter={(event) => { if (event.pointerType === "mouse") renderer.current?.greet("hover"); }}
        onClick={greet} />
      <span className={cx("gimbal-hello", !hello && "sr-only")} role="status" aria-live="polite">
        {hello ? "Hello. I’m here." : ""}
      </span>
    </div>
  );
}
