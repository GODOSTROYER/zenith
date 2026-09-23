"use client";

import Link from "next/link";
import { useEffect, useRef, type CSSProperties } from "react";
import { ArrowUpRight, FileCheck, Hand, MonitorCheck } from "lucide-react";
import { cx } from "@/lib/format";
import { AUTONOMY_LEVELS, AUTONOMY_MEANING } from "@/lib/navigator/shared";
import { AUTONOMY_NOTCH } from "./gimbal-guide";
import { useHighlight, useLanding } from "./landing-experience";
import { useReveal } from "./landing-motion";
import styles from "./chapters.module.css";
import feature from "./feature.module.css";
import local from "./gimbal-chapter.module.css";

/** Where "Read the docs" goes until the autonomy documentation has a home of its own. */
const DOCS_HREF = "/guide";

/** The five notches on a half circle of radius 170 around (200, 200), in the dial's 400 × 230 drawing. */
const NOTCHES = AUTONOMY_LEVELS.map((value, index) => {
  const angle = Math.PI - (index * Math.PI) / 4;
  return { value, index, left: `${((200 + 170 * Math.cos(angle)) / 400) * 100}%`, top: `${((200 - 170 * Math.sin(angle)) / 230) * 100}%` };
});

/** What never moves, whatever the level says. */
const KEEPS = [
  { icon: Hand, text: "You start every run" },
  { icon: MonitorCheck, text: "Approvals in your browser" },
  { icon: FileCheck, text: "Production needs your approval" },
];

/** How long the dial rests on a level before turning on its own, and how long it waits after a visitor turns it. */
const SWEEP_MS = 3400;
const PAUSE_AFTER_TOUCH_MS = 12000;

/** Delegate: policy explanations only. Nothing here reads or writes a workspace setting. */
export function GimbalChapter() {
  const { state, dispatch } = useLanding();
  const highlight = useHighlight("gimbal");
  const section = useRef<HTMLElement>(null);
  useReveal(section);
  const level = state.autonomy;
  const notch = AUTONOMY_NOTCH[level];
  const hot = highlight?.level;
  const boundaries = highlight?.region === "boundaries" || undefined;
  const walking = Boolean(state.walkthrough);
  const current = useRef(level);
  current.current = level;
  const touched = useRef(0);
  const direction = useRef(1);

  /* Left alone and in view, the dial turns through the levels on its own, up and then down, resting on each. */
  useEffect(() => {
    const element = section.current;
    if (!element || typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof IntersectionObserver === "undefined") return;
    let visible = false;
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }, { threshold: 0.35 });
    observer.observe(element);
    const timer = window.setInterval(() => {
      if (!visible || walking || Date.now() < touched.current) return;
      const index = AUTONOMY_LEVELS.indexOf(current.current);
      let next = index + direction.current;
      if (next < 0 || next >= AUTONOMY_LEVELS.length) { direction.current *= -1; next = index + direction.current; }
      dispatch({ type: "autonomy", level: AUTONOMY_LEVELS[next] });
    }, SWEEP_MS);
    return () => { observer.disconnect(); window.clearInterval(timer); };
  }, [dispatch, walking]);

  const choose = (value: (typeof AUTONOMY_LEVELS)[number]) => {
    touched.current = Date.now() + PAUSE_AFTER_TOUCH_MS;
    dispatch({ type: "autonomy", level: value });
  };

  return (
    <section ref={section} id="gimbal" data-chapter="gimbal" className={styles.chapter} aria-labelledby="gimbal-title">
      <div className={cx(styles.inner, feature.row)} data-balanced="true" data-reveal-group>
        <div className={feature.text}>
          <h2 id="gimbal-title" data-reveal>And you stay in control.</h2>
          <p data-reveal>
            Gimbal works as far as you let it: watching, planning, executing after your approval, or running whole plans inside your limits.
            <span className={local.note}>Turn the dial to see what each level allows; no workspace setting is changed here.</span>
          </p>
          <ul className={local.keeps} data-reveal>
            {KEEPS.map(({ icon: Icon, text }) => <li key={text} data-hot={boundaries}><i><Icon size={19} strokeWidth={1.7} aria-hidden="true" /></i>{text}</li>)}
          </ul>
          <div className={local.links} data-reveal>
            <Link href={DOCS_HREF} className="zenith-text-link">Read the docs <ArrowUpRight size={16} aria-hidden="true" /></Link>
          </div>
        </div>
        <div className={local.instrument} data-reveal>
          <div className={local.dial} role="group" aria-label="Explore the five autonomy levels" style={{ "--notch": notch - 1 } as CSSProperties}>
            <svg viewBox="0 0 400 230" aria-hidden="true">
              <path className={local.track} d="M30 200A170 170 0 0 1 370 200" pathLength={1} />
              <path className={local.fill} d="M30 200A170 170 0 0 1 370 200" pathLength={1} />
              <g className={local.needle}><line x1="200" y1="196" x2="200" y2="74" /><circle cx="200" cy="200" r="10" /></g>
            </svg>
            {NOTCHES.map(({ value, index, left, top }) => (
              <button key={value} type="button" className={local.notch} data-index={index} style={{ left, top }} aria-pressed={value === level} data-hot={hot === value || undefined} data-soft={hot && hot !== value ? true : undefined} onClick={() => choose(value)}>
                {index + 1}<span>{value}</span>
              </button>
            ))}
          </div>
          <p className={local.readout} aria-live="polite"><b>{notch}</b><span>{level}</span></p>
          <p className={local.meaning} aria-live="polite">{AUTONOMY_MEANING[level]}</p>
        </div>
      </div>
    </section>
  );
}
