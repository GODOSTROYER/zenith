"use client";

import { useRef } from "react";
import { Layers, Lock, Receipt } from "lucide-react";
import { cx, fmtUsd } from "@/lib/format";
import { useHighlight, useLanding } from "./landing-experience";
import { useCountUp, useReveal } from "./landing-motion";
import { SystemDiagram } from "./system-diagram";
import { ESTIMATE, FLOW_STORY, NODE_META, PROPOSED_BINDING_IDS, PROPOSED_CHANGE, PROPOSED_IDS, systemFor, type ExampleNodeId } from "./scenario";
import styles from "./chapters.module.css";
import feature from "./feature.module.css";

const money = (n: number) => fmtUsd(n);

/** Understand: the system as one typed definition, the change as a readable plan. */
export function BeforeChapter() {
  const { state, dispatch } = useLanding();
  const highlight = useHighlight("before");
  const section = useRef<HTMLElement>(null);
  const estimateEl = useRef<HTMLElement>(null);
  useReveal(section);
  const manifest = systemFor(state.view);
  const proposed = state.view === "proposed";
  useCountUp(estimateEl, proposed ? ESTIMATE.proposed : ESTIMATE.current, money);
  const present = (id: ExampleNodeId) => manifest.services.some((s) => s.id === id) || manifest.resources.some((r) => r.id === id) || manifest.routes.some((r) => r.id === id);
  const selected: ExampleNodeId = present(state.selected) ? state.selected : "upload-api";
  const meta = NODE_META[selected];
  const additions = PROPOSED_CHANGE.items.filter((i) => i.nodeType !== "binding").length;
  const links = PROPOSED_CHANGE.items.filter((i) => i.nodeType === "binding").length;
  const hot = (name: string) => ({ "data-hot": highlight?.region === name || undefined });
  return (
    <section ref={section} id="before" data-chapter="before" className={styles.chapter} aria-labelledby="before-title">
      <div className={cx(styles.inner, feature.row)} data-reveal-group>
        <div className={feature.text}>
          <h2 id="before-title" data-reveal>We map the system.</h2>
          <p data-reveal>Every part, every connection and every change, explained before anything runs.</p>
          <ul className={feature.pills}>
            <li className={feature.pill} data-reveal {...hot("plan")}><i><Layers size={22} strokeWidth={1.7} aria-hidden="true" /></i>One typed definition drives every view</li>
            <li className={feature.pill} data-reveal {...hot("estimate")}><i><Receipt size={22} strokeWidth={1.7} aria-hidden="true" /></i>Each change carries its risk and its cost</li>
            <li className={feature.pill} data-reveal><i><Lock size={22} strokeWidth={1.7} aria-hidden="true" /></i>Nothing runs until you approve it</li>
          </ul>
        </div>
        <div className={cx("zenith-ink", feature.card)} data-reveal>
          <div className={feature.cardHead}>
            <div className={styles.switch} role="group" aria-label="Which configuration to inspect">
              <button type="button" aria-pressed={!proposed} onClick={() => dispatch({ type: "view", view: "current" })}>Current system</button>
              <button type="button" aria-pressed={proposed} onClick={() => dispatch({ type: "view", view: "proposed" })}>Proposed change</button>
            </div>
            <span className={styles.mono}>{meta.label} · {meta.role}</span>
          </div>
          <SystemDiagram
            manifest={manifest}
            label={proposed ? "The proposed system: a queue and a worker added to the current system" : "The current system: a public address, the upload API, file storage and the results database"}
            proposedIds={proposed ? PROPOSED_IDS : []}
            proposedBindingIds={proposed ? PROPOSED_BINDING_IDS : []}
            selected={selected}
            onSelect={(node) => dispatch({ type: "select", node })}
            highlight={highlight}
            flow={FLOW_STORY[state.view]}
          />
          <div className={feature.cardStats}>
            <div className={feature.cardStat} {...hot("plan")}><b>{proposed ? `+${additions}` : "4"}</b><span>{proposed ? "parts added: queue, worker" : "parts running today"}</span></div>
            <div className={feature.cardStat}><b>{proposed ? `+${links}` : "3"}</b><span>{proposed ? "connections, explained and injected" : "connections, explained"}</span></div>
            <div className={feature.cardStat} {...hot("estimate")}><b ref={estimateEl} aria-live="polite">{fmtUsd(proposed ? ESTIMATE.proposed : ESTIMATE.current)}</b><span>{proposed ? `a month, ${fmtUsd(ESTIMATE.delta, { sign: true })} · estimate` : "a month · estimate, not a bill"}</span></div>
          </div>
          <details className={styles.details} style={{ borderBottom: 0, marginTop: 8 }}>
            <summary>What the plan says, item by item <span aria-hidden="true">+</span></summary>
            <ul className={styles.rows} aria-label="Plan items">
              {PROPOSED_CHANGE.items.map((item) => {
                const key = `${item.nodeType}:${item.nodeId}`;
                const items = new Set(highlight?.items ?? []);
                return <li key={key} className={styles.row} data-hot={items.has(key) || undefined} data-soft={items.size > 0 && !items.has(key) ? true : undefined}>
                  <span><span className={styles.title}>{item.nodeType === "binding" ? "Connect " + item.nodeName.replace(/→/g, "to") : "Add " + (NODE_META[item.nodeId as ExampleNodeId]?.label.toLowerCase() ?? item.nodeName)}</span><br /><span className={styles.explain}>{item.explanation}</span></span>
                  <span className={styles.meta}><span>{item.risk} risk</span><span>{item.costDeltaUsd === 0 ? "no cost" : `${fmtUsd(item.costDeltaUsd, { sign: true })} / month`}</span></span>
                </li>;
              })}
            </ul>
          </details>
          <div className={feature.cardFoot}><span>Example system · synthetic · no cloud connection</span><span>Select a part to inspect it</span></div>
        </div>
      </div>
    </section>
  );
}
