"use client";

import { useEffect, useRef, useState } from "react";
import { RevisionFallback } from "./revision-fallback";
import type { RevisionRenderer } from "./revision-renderer";
import styles from "./revision-scene.module.css";

export type RevisionPhase = "current" | "proposed" | "applying" | "recorded" | "restored";
export type RevisionService = "atlas-api" | "atlas-worker" | "atlas-jobs";
export interface RevisionSceneProps {
  phase: RevisionPhase;
  selected?: RevisionService;
  className?: string;
  tone?: "light" | "dark";
  still?: boolean;
}

/** A decorative projection of the revision. All controls and semantics live in HTML. */
export function RevisionScene({ phase, selected, className, tone = "light", still = false }: RevisionSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<RevisionRenderer | null>(null);
  const latest = useRef({ phase, selected, tone, still });
  latest.current = { phase, selected, tone, still };
  const sync = useRef(() => {});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    setReady(false);
    let disposed = false;
    let starting = false;
    let failed = false;
    let visible = false;
    let paintFrame: number | null = null;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
    const lowPower = (nav.hardwareConcurrency || 8) <= 4 || (nav.deviceMemory || 8) <= 4 || !!nav.connection?.saveData;
    const settings = () => ({ ...latest.current, reducedMotion: preference.matches || latest.current.still });
    sync.current = () => instance.current?.setState(settings());
    const fail = () => {
      failed = true;
      if (!disposed) setReady(false);
      instance.current?.dispose();
      instance.current = null;
    };
    const visibility = () => {
      const active = visible && document.visibilityState !== "hidden";
      instance.current?.setVisible(active);
      if (!active || starting || failed || disposed || instance.current) return;
      starting = true;
      // Let the licensed type settle and reach the screen before initializing
      // WebGL. The SVG is the complete first frame; shader work must not delay it.
      const painted = (document.fonts?.ready ?? Promise.resolve()).then(() => new Promise<void>((resolve) => {
        if (disposed) { resolve(); return; }
        paintFrame = requestAnimationFrame(() => {
          paintFrame = requestAnimationFrame(() => { paintFrame = null; resolve(); });
        });
      }));
      void painted.then(() => {
        if (disposed || !visible || document.visibilityState === "hidden") return null;
        return import("./revision-renderer");
      }).then((module) => {
        if (!module || disposed || !visible || document.visibilityState === "hidden") return;
        const { createRevisionRenderer } = module;
        const renderer = createRevisionRenderer(element, {
          ...settings(), lowPower,
          onReady: () => { if (!disposed && !failed) setReady(true); },
          onError: fail,
        });
        if (disposed || failed) { renderer.dispose(); return; }
        instance.current = renderer;
        renderer.setState(settings());
        renderer.setVisible(visible);
      }).catch(fail).finally(() => { starting = false; });
    };
    const bounds = element.getBoundingClientRect();
    visible = bounds.bottom > 0 && bounds.top < window.innerHeight && bounds.width > 0;
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      visibility();
    }, { rootMargin: "80px" });
    observer?.observe(element);
    const preferenceChanged = () => sync.current();
    preference.addEventListener("change", preferenceChanged);
    document.addEventListener("visibilitychange", visibility);
    visibility();
    return () => {
      disposed = true;
      if (paintFrame !== null) cancelAnimationFrame(paintFrame);
      observer?.disconnect();
      preference.removeEventListener("change", preferenceChanged);
      document.removeEventListener("visibilitychange", visibility);
      instance.current?.dispose();
      instance.current = null;
      sync.current = () => {};
    };
  }, []);

  useEffect(() => { sync.current(); }, [phase, selected, tone, still]);

  return (
    <div className={[styles.scene, className].filter(Boolean).join(" ")} data-phase={phase} data-tone={tone} data-renderer={ready ? "webgl" : "svg"} aria-hidden="true">
      <div className={styles.fallback} style={{ opacity: ready ? 0 : 1 }}>
        <RevisionFallback phase={phase} selected={selected} tone={tone} />
      </div>
      <div className={styles.canvas} ref={host} style={{ opacity: ready ? 1 : 0 }} />
    </div>
  );
}
