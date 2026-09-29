"use client";

import { useEffect, useRef, useState } from "react";
import { Glyph } from "./bento-visuals";
import styles from "./bento-agent-flow.module.css";

/** A presentation-only illustration. CSS owns the timeline; no action API or timers. */
export function BentoAgentFlow() {
  const root = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const element = root.current;
    if (!element || typeof window.matchMedia !== "function" || typeof IntersectionObserver === "undefined") return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let inView = false;
    const sync = () => {
      element.dataset.loop = motion.matches ? "still" : inView && !document.hidden && !paused ? "running" : "paused";
    };
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting && entry.intersectionRatio >= 0.15;
      sync();
    }, { threshold: 0.15 });
    // A reduced-motion visitor gets the complete, static review diagram.
    const observe = () => {
      observer.disconnect();
      inView = false;
      if (!motion.matches) observer.observe(element);
      sync();
    };
    observe();
    motion.addEventListener("change", observe);
    document.addEventListener("visibilitychange", sync);
    return () => {
      observer.disconnect();
      motion.removeEventListener("change", observe);
      document.removeEventListener("visibilitychange", sync);
      element.dataset.loop = "still";
    };
  }, [paused]);

  return <div ref={root} className={styles.loop} data-agent-loop data-loop="still">
    <div role="img" aria-label="Illustrated example: you and an agent share one plan and review path. The flow pauses for approval before continuing to run. No live cloud action.">
      <div className={styles.scene} aria-hidden="true">
        <div className={styles.request}>
          <span className={styles.avatar}><Glyph name="agent" /></span>
          <div><small>Example request</small><p>Move uploads into the background.</p></div>
        </div>
        <div className={styles.flow}>
          <div className={styles.origins}>
            <span><Glyph name="person" size={16} />You</span>
            <span className={`${styles.agent} ${styles.animated}`}><Glyph name="agent" size={16} />Agent</span>
          </div>
          <svg className={styles.merge} viewBox="0 0 20 96" fill="none"><path d="M0 24C12 24 8 48 20 48M0 72C12 72 8 48 20 48" /></svg>
          <div className={styles.rail}><i className={`${styles.pulse} ${styles.leadPulse} ${styles.animated}`} /></div>
          <span className={`${styles.plan} ${styles.animated}`}>Plan</span>
          <div className={styles.rail}><i className={`${styles.pulse} ${styles.reviewPulse} ${styles.animated}`} /></div>
          <div className={`${styles.gate} ${styles.animated}`}>
            <span className={`${styles.reviewFace} ${styles.animated}`}><Glyph name="lock" size={17} />Review</span>
            <span className={`${styles.approvedFace} ${styles.animated}`}><Glyph name="check" size={17} />Approved</span>
          </div>
          <div className={styles.rail}><i className={`${styles.pulse} ${styles.runPulse} ${styles.animated}`} /></div>
          <span className={`${styles.run} ${styles.animated}`}><Glyph name="worker" size={17} /><span>Run</span></span>
        </div>
      </div>
    </div>
    <button type="button" className={styles.motionControl}
      aria-label={paused ? "Play agent flow animation" : "Pause agent flow animation"}
      title={paused ? "Play animation" : "Pause animation"}
      onClick={() => setPaused((value) => !value)}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        {paused ? <path d="m5 3 8 5-8 5V3Z" /> : <path d="M4 3h3v10H4zM9 3h3v10H9z" />}
      </svg>
    </button>
  </div>;
}
