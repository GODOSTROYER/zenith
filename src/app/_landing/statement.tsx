"use client";

import { useRef } from "react";
import { useCountOnView, useReveal, useStatementReveal } from "./landing-motion";
import styles from "./statement.module.css";

const STATEMENT_LEAD = "Behind every app is a system. Zenith brings yours into focus — so you can see what changes, understand the cost,";
const STATEMENT_ACCENT = "and decide what runs.";
const STATEMENT = `${STATEMENT_LEAD} ${STATEMENT_ACCENT}`;
// Derive the boundary from the copy so the final thought always carries the accent.
const ACCENT_FROM = STATEMENT_LEAD.split(" ").length;

/** A quiet introduction to the product story, lit word by word as it scrolls. */
export function Statement() {
  const section = useRef<HTMLElement>(null);
  useStatementReveal(section);
  const words = STATEMENT.split(" ");
  return (
    <section ref={section} id="statement" className={styles.statement} data-chapter="hero" aria-label="What Zenith does">
      <div className={styles.sticky}>
        <p className={styles.words}>
          {words.map((word, index) => <span key={index} data-word className={index >= ACCENT_FROM ? styles.accent : undefined}>{word} </span>)}
        </p>
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
