"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "@/lib/format";
import type { GimbalState } from "./gimbal-contract";
import type { GimbalMaterial, GimbalRenderer } from "./gimbal-renderer";
import { GimbalFallback } from "./gimbal-fallback";

export type GimbalMotion = "auto" | "still" | "low-power";

/** Visible-only gyroscope. Workflow information remains in adjacent HTML. */
export function GimbalCharacter({ state, motion = "auto", material = "alloy", className }: {
  state: GimbalState | null;
  motion?: GimbalMotion;
  material?: GimbalMaterial;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<GimbalRenderer | null>(null);
  const latestState = useRef(state);
  const latestMotion = useRef(motion);
  const syncSettings = useRef<() => void>(() => {});
  const greetingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hello, setHello] = useState(false);
  const [active, setActive] = useState(false);
  const [ready, setReady] = useState(false);
  latestState.current = state;
  latestMotion.current = motion;

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
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    const lowPower = () => latestMotion.current === "low-power" || connection?.saveData === true || navigator.hardwareConcurrency <= 4;
    const reducedMotion = () => latestMotion.current === "still" || preference.matches;
    syncSettings.current = () => {
      renderer.current?.setReducedMotion(reducedMotion());
      renderer.current?.setLowPower(lowPower());
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
          material,
          reducedMotion: reducedMotion(),
          lowPower: lowPower(),
          onReady: () => { if (!disposed) setReady(true); },
          onError: () => { failed = true; recover(); },
        });
        if (disposed || failed) { instance.dispose(); return; }
        renderer.current = instance;
        starting = false;
        instance.setState(latestState.current);
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
  useLayoutEffect(() => { syncSettings.current(); }, [motion]);

  const greet = () => {
    if (greetingTimer.current) return;
    renderer.current?.greet("tap");
    setHello(true);
    greetingTimer.current = setTimeout(() => { setHello(false); greetingTimer.current = null; }, 1800);
  };

  return (
    <div className={cx("gimbal-character", className)} data-gimbal-state={state ?? "neutral"}
      data-renderer={ready ? "3d" : "static"} data-motion={motion} data-material={material} data-active={active}>
      <span className="gimbal-aura" aria-hidden="true" />
      <span key={state} className="gimbal-state-pulse" aria-hidden="true" />
      <GimbalFallback state={state} material={material} hidden={ready} />
      <div className="gimbal-canvas" ref={host} aria-hidden="true" />
      <button type="button" className="gimbal-greeting" aria-label="Say hello to Gimbal"
        title="Say hello to Gimbal"
        onPointerEnter={(event) => { if (event.pointerType === "mouse") renderer.current?.greet("hover"); }}
        onClick={greet} />
      <span className={cx("gimbal-hello", !hello && "sr-only")} role="status" aria-live="polite">
        {hello ? "Hello. I’m here." : ""}
      </span>
    </div>
  );
}
