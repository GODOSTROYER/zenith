"use client";

import { Fragment, useRef, type CSSProperties } from "react";
import { Cog, Database, HardDrive, Inbox, Plus, Server } from "lucide-react";
import { cx, fmtUsd } from "@/lib/format";
import { useHighlight, useLanding } from "./landing-experience";
import { useCountUp, useReveal } from "./landing-motion";
import { NODE_META, SCALE_ASSUMPTIONS, SCALE_STEPS, costDriver, nodeCost, type ExampleNodeId } from "./scenario";
import styles from "./chapters.module.css";
import local from "./scenario-chapter.module.css";

const money = (n: number) => fmtUsd(n);

/** The parts that grow, left to right along a request's path. */
const PARTS: { id: ExampleNodeId; label: string; icon: typeof Server }[] = [
  { id: "upload-api", label: "Upload API", icon: Server },
  { id: "process-jobs", label: "Queue", icon: Inbox },
  { id: "process-worker", label: "Workers", icon: Cog },
  { id: "uploads", label: "File storage", icon: HardDrive },
  { id: "results", label: "Database", icon: Database },
];

/** How large each size tier draws: the picture grows with the configuration. */
const TIER: Record<string, number> = { nano: 0.5, small: 0.64, standard: 0.82, performance: 1 };

/** Growth as a picture: five orbs that grow with the sizing, a count on each service, one estimate. */
export function ScenarioChapter() {
  const { state, dispatch } = useLanding();
  const highlight = useHighlight("scenarios");
  const section = useRef<HTMLElement>(null);
  const estimateEl = useRef<HTMLParagraphElement>(null);
  useReveal(section);
  const step = SCALE_STEPS[state.scale];
  const driver = costDriver(step.manifest);
  useCountUp(estimateEl, step.estimate, money);
  const region = (name: string) => ({ "data-hot": highlight?.region === name || undefined });
  const hotNodes = new Set(highlight?.nodes ?? []);
  return (
    <section ref={section} id="scenarios" data-chapter="scenarios" className={styles.chapter} aria-labelledby="scenarios-title">
      <div className={styles.inner}>
        <div className={styles.intro} data-reveal-group>
          <h2 id="scenarios-title" data-reveal>What changes<br /><em>when you grow?</em></h2>
          <p className={styles.lede} data-reveal>Pick a day’s traffic. The system and its estimate grow with it.</p>
        </div>
        <div className={cx("zenith-ink", local.card)} data-reveal>
          <div className={local.stage}>
            <div className={local.head}>
              <div className={styles.switch} role="group" aria-label="Uploads a day">
                {SCALE_STEPS.map((item, index) => <button key={item.id} type="button" aria-pressed={state.scale === index} onClick={() => dispatch({ type: "scale", scale: index })}>{item.uploadsPerDay}</button>)}
              </div>
              <span className={local.unit}>uploads a day</span>
            </div>
            <div className={local.scene} role="group" aria-label={`The example system sized for ${step.uploadsPerDay} uploads a day`} style={{ "--speed": state.scale + 1 } as CSSProperties}>
              {PARTS.map(({ id, label, icon: Icon }, index) => {
                const service = step.manifest.services.find((s) => s.id === id);
                const resource = step.manifest.resources.find((r) => r.id === id);
                const size = service?.size ?? resource?.size ?? "small";
                const hot = hotNodes.has(id);
                return (
                  <Fragment key={id}>
                    {index > 0 && <svg className={local.link} aria-hidden="true"><line x1="0" y1="1" x2="100%" y2="1" /></svg>}
                    <button type="button" className={local.part} aria-pressed={state.selected === id} data-hot={hot || undefined} data-soft={hotNodes.size > 0 && !hot ? true : undefined} onClick={() => dispatch({ type: "select", node: id })}>
                      <span className={local.orbBox}>
                        <span className={local.orb} style={{ "--s": TIER[size] ?? 0.64 } as CSSProperties}>
                          <Icon strokeWidth={1.6} aria-hidden="true" />
                          {service && <span key={service.replicas} className={local.count}><span aria-hidden="true">×</span>{service.replicas}<span className={local.sr}> {service.replicas === 1 ? "replica" : "replicas"}</span></span>}
                        </span>
                      </span>
                      <span>{label}</span>
                      <span className={local.sr}>, {size} size</span>
                    </button>
                  </Fragment>
                );
              })}
            </div>
          </div>
          <div className={local.estimate} {...region("estimate")}>
            <p className={local.kicker}>Estimated monthly cost</p>
            <p className={local.stat} ref={estimateEl} aria-live="polite">{fmtUsd(step.estimate)}</p>
            <p className={local.for}>for {step.uploadsPerDay} uploads a day</p>
            <p className={local.change} aria-live="polite">{step.change}</p>
            <p className={local.share}>{NODE_META[driver].label} is the biggest share at {fmtUsd(nodeCost(step.manifest, driver))}.{state.selected !== driver && ` ${NODE_META[state.selected].label}: ${fmtUsd(nodeCost(step.manifest, state.selected))}.`}</p>
            <span className={styles.pill} data-tone="accent"><i />Concept preview · illustrative</span>
            <details className={local.how} {...region("assumptions")}>
              <summary>How these numbers are made <Plus size={14} aria-hidden="true" /></summary>
              <ul>{SCALE_ASSUMPTIONS.map((line) => <li key={line}>{line}</li>)}</ul>
              <p>Zenith prices the configuration with its estimate tables. It does not forecast traffic; the sizing rules are this page’s.</p>
            </details>
          </div>
        </div>
      </div>
    </section>
  );
}
