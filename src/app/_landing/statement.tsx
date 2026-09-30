"use client";

import { useRef } from "react";
import { useCountOnView, useReveal, useStatementReveal } from "./landing-motion";
import styles from "./statement.module.css";
import { StartupPrograms } from "./startup-programs";

const STATEMENT = "Zenith turns the app you’re building into infrastructure you can see, change and run. Before anything runs. And long after.";
const ACCENT_FROM = 12; // "Before anything runs. And long after."

/** Logos hand off to the statement in one centered stage before the product tour. */
export function Statement() {
  const section = useRef<HTMLElement>(null);
  useStatementReveal(section);
  const words = STATEMENT.split(" ");
  return (
    <section ref={section} id="startup-programs" className={styles.statement} data-chapter="hero" aria-label="Zenith introduction">
      <div className={styles.sticky}>
        <div className={styles.scene} data-program-scene><StartupPrograms /></div>
        <div id="statement" className={styles.scene} data-statement-scene role="region" aria-label="What Zenith does">
          <p className={styles.words}>
            {words.map((word, index) => <span key={index} data-word className={index >= ACCENT_FROM ? styles.accent : undefined}>{word} </span>)}
          </p>
        </div>
      </div>
    </section>
  );
}

const FACTS: { value: number; label: string }[] = [
  { value: 1, label: "typed definition of your whole system" },
  { value: 5, label: "levels of autonomy, one dial" },
  { value: 2, label: "agents you already use, linked in your browser" },
  { value: 0, label: "lines of code to read on this page" },
];

function Fact({ value, label }: { value: number; label: string }) {
  const number = useRef<HTMLSpanElement>(null);
  useCountOnView(number, value, (n) => String(Math.round(n)));
  return <li data-reveal><span ref={number} className={styles.number}>{value}</span><span className={styles.label}>{label}</span></li>;
}

/** Only the real facts. No customers, downloads or benchmarks are invented. */
export function Facts() {
  const section = useRef<HTMLElement>(null);
  useReveal(section);
  return (
    <section ref={section} className={styles.facts} data-chapter="hero" aria-label="Only the real facts">
      <p className={styles.kicker} data-reveal>Only the real facts.</p>
      <ul className={styles.grid} data-reveal-group>{FACTS.map((fact) => <Fact key={fact.label} {...fact} />)}</ul>
    </section>
  );
}
