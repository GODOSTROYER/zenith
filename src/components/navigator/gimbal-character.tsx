"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "@/lib/format";
import type { GimbalState } from "./gimbal-contract";
import type { GimbalRenderer } from "./gimbal-renderer";
import { GimbalFallback } from "./gimbal-fallback";

export type GimbalMotion = "auto" | "still" | "low-power";

/** Visible-only gyroscope. Workflow information remains in adjacent HTML. */
export function GimbalCharacter({ state, motion = "auto", className }: {
  state: GimbalState | null;
  motion?: GimbalMotion;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<GimbalRenderer | null>(null);
  const latestState = useRef(state);
  const [ready, setReady] = useState(false);
  latestState.current = state;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    setReady(false);
    let starting = false;
    let visible = false;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    const lowPower = motion === "low-power" || connection?.saveData === true || navigator.hardwareConcurrency <= 4;
    const reducedMotion = () => motion === "still" || preference.matches;

    const syncVisibility = () => {
      const active = visible && document.visibilityState === "visible";
      renderer.current?.setVisible(active);
      if (!active || starting) return;
      starting = true;
      // Keep the Three.js renderer out of the server compilation graph.
      if (typeof window === "undefined") return;
      void import("./gimbal-renderer").then(async ({ createGimbalRenderer }) => {
        if (disposed) return;
        const instance = await createGimbalRenderer(element, {
          state: latestState.current,
          reducedMotion: reducedMotion(),
          lowPower,
          onReady: () => { if (!disposed) setReady(true); },
          onError: () => { if (!disposed) setReady(false); },
        });
        if (disposed) { instance.dispose(); return; }
        renderer.current = instance;
        instance.setState(latestState.current);
        instance.setReducedMotion(reducedMotion());
        instance.setVisible(visible && document.visibilityState === "visible");
      }).catch(() => { if (!disposed) setReady(false); });
    };

    const bounds = element.getBoundingClientRect();
    visible = bounds.bottom > 0 && bounds.top < window.innerHeight && bounds.width > 0;
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      syncVisibility();
    });
    observer.observe(element);
    const changeMotion = () => renderer.current?.setReducedMotion(reducedMotion());
    preference.addEventListener("change", changeMotion);
    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();

    return () => {
      disposed = true;
      observer.disconnect();
      preference.removeEventListener("change", changeMotion);
      document.removeEventListener("visibilitychange", syncVisibility);
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [motion]);

  useLayoutEffect(() => { renderer.current?.setState(state); }, [state]);

  return (
    <div className={cx("gimbal-character", className)} data-gimbal-state={state ?? "neutral"}
      data-renderer={ready ? "3d" : "static"}>
      <GimbalFallback state={state} hidden={ready} />
      <div className="gimbal-canvas" ref={host} aria-hidden="true" />
      <button type="button" className="gimbal-greeting" aria-label="Say hello to Gimbal"
        title={motion === "still" ? "Gimbal is in still mode" : "Say hello to Gimbal"}
        onPointerEnter={(event) => { if (event.pointerType === "mouse") renderer.current?.greet("hover"); }}
        onClick={() => renderer.current?.greet("tap")} />
    </div>
  );
}
