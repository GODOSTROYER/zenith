"use client";

import Link from "next/link";
import { useRef } from "react";
import { ArrowUpRight, Asterisk, Check, CircleCheck, FileSearch, Hexagon, Link2, Lock, Unplug } from "lucide-react";
import { ZENITH_SYMBOL_PATHS } from "@/components/shell/brand-geometry";
import { cx } from "@/lib/format";
import { useHighlight, useLanding } from "./landing-experience";
import { useFlowMotion, useReveal } from "./landing-motion";
import styles from "./chapters.module.css";
import local from "./agents-chapter.module.css";

/** Where "Read the docs" goes until the plugin documentation has a home of its own. */
const DOCS_HREF = "/guide";

type StationId = "agent" | "link" | "change" | "approve";

/** The flow, left to right. Each station stands for one or more of the sequence's six steps. */
const STATIONS: { id: StationId; label: string; steps: number[]; hint: string }[] = [
  { id: "agent", label: "Claude Code or Codex", steps: [0], hint: "Install the Zenith plugin. Nothing in your account changes." },
  { id: "link", label: "Linked in your browser", steps: [1, 2], hint: "Match the code, sign in, choose scopes. Read always; write only if you grant it." },
  { id: "change", label: "One exact change", steps: [3], hint: "It reads your workspace and prepares one exact change, with a digest." },
  { id: "approve", label: "You approve", steps: [4, 5], hint: "You approve that digest in the browser. It runs once and reports what happened." },
];

function ZenithMark() {
  return <svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">{ZENITH_SYMBOL_PATHS.map((d) => <path key={d} d={d} />)}</svg>;
}

/** One station's picture. The two app tiles are drawn in the products' own colours; no official logo is reproduced. */
function Node({ id }: { id: StationId }) {
  switch (id) {
    case "agent": return (
      <div className={local.agents} data-flow-node>
        <span className={cx(local.app, local.claude)} role="img" aria-label="Claude Code"><Asterisk size={22} strokeWidth={2.8} aria-hidden="true" /></span>
        <span className={cx(local.app, local.codex)} role="img" aria-label="Codex"><Hexagon size={20} strokeWidth={2.3} aria-hidden="true" /></span>
      </div>
    );
    case "link": return <div className={cx(local.node, local.zenith)} data-flow-node><ZenithMark /><b className={cx(local.badge, local.badgeIcon)}><Link2 size={11} strokeWidth={2.6} aria-hidden="true" /></b></div>;
    case "change": return <div className={local.node} data-flow-node><FileSearch size={27} strokeWidth={1.6} aria-hidden="true" /><b className={local.badge}>+2</b></div>;
    default: return <div className={cx(local.node, local.gate)} data-flow-node data-flow-gate><span className={local.gateBar}><i /><i /><i /></span><Check size={26} strokeWidth={2.6} aria-hidden="true" /></div>;
  }
}

export function AgentsChapter() {
  const { state, dispatch } = useLanding();
  const highlight = useHighlight("agents");
  const section = useRef<HTMLElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  useReveal(section);
  useFlowMotion(flow);
  const hotSteps = new Set(highlight?.steps ?? []);
  const active = STATIONS.find((station) => station.steps.includes(state.agentStep)) ?? STATIONS[0];
  return (
    <section ref={section} id="agents" data-chapter="agents" className={styles.chapter} aria-labelledby="agents-title">
      <div className={styles.inner}>
        <div className={styles.intro} data-reveal-group>
          <h2 id="agents-title" data-reveal>Keep the tools<br /><em>you already use.</em></h2>
          <p className={cx(styles.lede, local.lede)} data-reveal>Claude Code or Codex. Linked once. Approved by you.</p>
        </div>
        <div className={styles.bento} data-reveal-group>
          <div className={cx(styles.tile, local.flowTile)} data-reveal>
            <div ref={flow} className={local.flow} role="group" aria-label="The linking and approval sequence">
              <span className={local.line} aria-hidden="true" />
              <i className={local.pulse} data-flow-pulse aria-hidden="true" />
              {STATIONS.map((station) => {
                const hot = station.steps.some((step) => hotSteps.has(step));
                return (
                  <button key={station.id} type="button" className={local.station} data-flow-station aria-pressed={station === active} data-hot={hot || undefined} data-soft={hotSteps.size > 0 && !hot ? true : undefined} onClick={() => dispatch({ type: "agent-step", step: station.steps[0] })}>
                    <Node id={station.id} /><span className={local.stationLabel}>{station.label}</span>
                  </button>
                );
              })}
            </div>
            <p className={local.hint} aria-live="polite">{active.hint}</p>
          </div>
          <div className={cx(styles.chip, styles.span4)} data-reveal><Unplug size={18} aria-hidden="true" /><span>Linking isn’t deploying<small>Approving the link creates nothing.</small></span></div>
          <div className={cx(styles.chip, styles.span4)} data-reveal><Lock size={18} aria-hidden="true" /><span>Read is the minimum<small>Write only if you grant it.</small></span></div>
          <div className={cx(styles.chip, styles.span4)} data-reveal><CircleCheck size={18} aria-hidden="true" /><span>You approve every write<small>The agent can’t approve itself.</small></span></div>
        </div>
        <div className={local.foot} data-reveal>
          <Link className={styles.external} href={DOCS_HREF}>Read the docs <ArrowUpRight size={14} aria-hidden="true" /></Link>
        </div>
      </div>
    </section>
  );
}
