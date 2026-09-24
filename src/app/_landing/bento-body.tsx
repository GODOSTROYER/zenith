"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { OrbitMark, Wordmark } from "@/components/shell/wordmark";
import { AUTONOMY_LEVELS, AUTONOMY_MEANING } from "@/lib/navigator/shared";
import { fmtUsd } from "@/lib/format";
import type { Cta } from "./cta";
import type { ProviderRow } from "./landing";
import type { ChapterId } from "./landing-state";
import { LandingCta } from "./landing-cta";
import { useHighlight, useLanding } from "./landing-experience";
import { ESTIMATE, NODE_META, PROPOSED_CHANGE, PROPOSED_IDS, SCALE_STEPS, systemFor } from "./scenario";
import { EXPORT_ARTIFACTS, planRiskLabel, providerPresentation, TEAM_STORIES } from "./bento-data";
import { BentoSystemMap, Glyph, type GlyphName } from "./bento-visuals";
import { BentoAgentFlow } from "./bento-agent-flow";
import styles from "./bento-body.module.css";

function Card({ id, chapter, className, children }: {
  id: string;
  chapter?: ChapterId;
  className: string;
  children: ReactNode;
}) {
  return <article id={id} data-chapter={chapter} data-bento className={`${styles.card} ${className}`} aria-labelledby={`${id}-title`}>{children}</article>;
}

function CardTitle({ id, label, children, description }: {
  id: string;
  label: string;
  children: ReactNode;
  description?: string;
}) {
  return <header className={styles.cardCopy}>
    <p className={styles.label}>{label}</p>
    <h3 id={`${id}-title`}>{children}</h3>
    {description && <p className={styles.description}>{description}</p>}
  </header>;
}

function ViewSwitch() {
  const { state, dispatch } = useLanding();
  return <div className={styles.viewSwitch} role="group" aria-label="Example system view">
    <button type="button" aria-pressed={state.view === "current"} onClick={() => dispatch({ type: "view", view: "current" })}>Current</button>
    <button type="button" aria-pressed={state.view === "proposed"} onClick={() => dispatch({ type: "view", view: "proposed" })}>Proposed <span aria-hidden="true">+</span></button>
  </div>;
}

function SystemCard() {
  const { state, dispatch } = useLanding();
  const highlight = useHighlight("before");
  const manifest = systemFor(state.view);
  const ids = new Set([...manifest.services, ...manifest.resources, ...manifest.routes].map((part) => part.id));
  const candidate = state.selected;
  const selected = ids.has(candidate) ? candidate : "upload-api";
  return <Card id="before" chapter="before" className={styles.mapCard}>
    <div className={styles.mapIntro}>
      <CardTitle id="before" label="The whole picture" description="See the parts. Understand how they fit. Stay connected to what you’re building.">Your whole app.<br />One clear picture.</CardTitle>
      <ViewSwitch />
    </div>
    <div className={styles.mapArt}>
      <BentoSystemMap view={state.view} selected={selected} highlighted={highlight?.nodes} onSelect={(node) => dispatch({ type: "select", node })} />
      <p className={styles.mapCaption}><b>{NODE_META[selected].label}</b><span>{NODE_META[selected].role}</span></p>
    </div>
  </Card>;
}

function AgentCard() {
  return <Card id="agents" chapter="agents" className={`${styles.agentCard} zenith-ink`}>
    <CardTitle id="agents" label="Same rules. No side doors." description="People and linked agents enter the same plan, review, and approval path.">Agents help.<br />You hold the keys.</CardTitle>
    <BentoAgentFlow />
  </Card>;
}

function PreviewCard() {
  const { state, dispatch } = useLanding();
  const proposed = state.view === "proposed";
  return <Card id="preview" className={styles.previewCard}>
    <CardTitle id="preview" label="Plan before change" description="A new idea becomes a plan you can understand. Not a surprise you have to undo.">See the next move.<br />Before you make it.</CardTitle>
    <div className={styles.planStack} data-proposed={proposed}>
      <div className={styles.planBack} aria-hidden="true"><span>Current system</span><i /><i /><i /></div>
      <div className={styles.planSheet}>
        <div className={styles.planHeading}><Glyph name="layers" /><b>{proposed ? "Your proposed change" : "Your current system"}</b><span>{proposed ? "Preview" : "Example"}</span></div>
        {proposed ? PROPOSED_IDS.map((id) => <div key={id} className={styles.planRow}><span className={styles.plus}>+</span><div><b>{NODE_META[id].label}</b><small>{NODE_META[id].role}</small></div><span className={styles.added}>Add</span></div>) : <div className={styles.unchanged}><Glyph name="app" size={26} /><p>The app handles uploads and processing.<br /><b>No changes proposed.</b></p></div>}
        <div className={styles.planBottom}><span><Glyph name="lock" size={13} />{proposed ? "Review before execution" : "Nothing has changed"}</span><b>{proposed ? planRiskLabel(PROPOSED_CHANGE.items) : "Current"}</b></div>
      </div>
    </div>
    <button type="button" className={styles.textButton} onClick={() => dispatch({ type: "view", view: proposed ? "current" : "proposed" })}>{proposed ? "Compare with current" : "Preview the change"}<Glyph name="arrow" size={17} /></button>
  </Card>;
}

function AutonomyCard() {
  const { state, dispatch } = useLanding();
  const highlight = useHighlight("gimbal");
  const level = state.autonomy;
  return <Card id="gimbal" chapter="gimbal" className={styles.autonomyCard}>
    <div className={styles.autonomyCopy}>
      <CardTitle id="gimbal" label="A dial, not a blank cheque">Your agent.<br />Your limits.</CardTitle>
      <p className={styles.autonomyMeaning} role="status">{AUTONOMY_MEANING[level]}</p>
      <p className={styles.finePrint}>Explore the five levels.<br />No workspace setting is changed.</p>
    </div>
    <div className={styles.autonomyLevels} role="group" aria-label="Explore autonomy levels">
      {AUTONOMY_LEVELS.map((value, index) => <button type="button" key={value} data-guide={highlight?.level === value || undefined} aria-pressed={value === level} onClick={() => dispatch({ type: "autonomy", level: value })}>
        <span className={styles.levelDots} aria-hidden="true">{[0, 1, 2, 3, 4].map((dot) => <i key={dot} data-lit={dot <= index} />)}</span>
        <span>{value}</span>{value === level && <Glyph name="check" size={18} />}
      </button>)}
    </div>
  </Card>;
}

function EstimateCard() {
  const { state, dispatch } = useLanding();
  const proposed = state.view === "proposed";
  const estimate = proposed ? ESTIMATE.proposed : ESTIMATE.current;
  const growth = SCALE_STEPS[state.scale];
  const max = Math.max(ESTIMATE.current, ESTIMATE.proposed, 1);
  return <Card id="scenarios" chapter="scenarios" className={styles.estimateCard}>
    <CardTitle id="scenarios" label="Impact, up front">Less guesswork.<br />More foresight.</CardTitle>
    <div className={styles.estimateReadout} role="status"><b>{fmtUsd(estimate)}</b><span>/ month<br /><strong>estimated</strong></span></div>
    <div className={styles.costBars} aria-label={`Current estimate ${fmtUsd(ESTIMATE.current)}, proposed estimate ${fmtUsd(ESTIMATE.proposed)} per month`}>
      <div><span>Current</span><i style={{ "--bar": `${ESTIMATE.current / max * 100}%` } as CSSProperties} /><b>{fmtUsd(ESTIMATE.current)}</b></div>
      <div data-selected={proposed}><span>Proposed</span><i style={{ "--bar": `${ESTIMATE.proposed / max * 100}%` } as CSSProperties} /><b>{fmtUsd(ESTIMATE.proposed)}</b></div>
    </div>
    <p className={styles.estimateDelta}>{fmtUsd(ESTIMATE.delta, { sign: true })} / month for the proposed change.</p>
    <details className={styles.growthDetails}>
      <summary>Explore a growth scenario</summary>
      <label htmlFor="bento-growth">{growth.uploadsPerDay} uploads / day <span>· concept preview</span></label>
      <input id="bento-growth" type="range" min="0" max={SCALE_STEPS.length - 1} step="1" value={state.scale} aria-valuetext={`${growth.uploadsPerDay} uploads per day; illustrative monthly estimate ${fmtUsd(growth.estimate)}`} onChange={(event) => dispatch({ type: "scale", scale: Number(event.target.value) })} />
      <p>{fmtUsd(growth.estimate)} / month · illustrative sizing, not a traffic forecast.</p>
    </details>
    <p className={styles.finePrint}>Synthetic example · product estimate tables.<br />Not a bill, forecast, or Zenith subscription price.</p>
  </Card>;
}

const VIEWS: { label: string; icon: GlyphName }[] = [
  { label: "System", icon: "app" }, { label: "Plans", icon: "layers" },
  { label: "Actions", icon: "agent" }, { label: "Exports", icon: "document" },
];
function FoundationCard() {
  return <Card id="foundation" className={styles.foundationCard}>
    <CardTitle id="foundation" label="Connected by design" description="The picture, the plan, and the action path share one underlying model.">One system.<br />Not another silo.</CardTitle>
    <div className={styles.foundationArt} aria-hidden="true">
      <div className={styles.foundationCore}><OrbitMark size={26} /><span>zenith</span></div>
      <div className={styles.foundationStem} />
      <div className={styles.foundationViews}>{VIEWS.map(({ label, icon }) => <div key={label}><Glyph name={icon} size={20} /><span>{label}</span></div>)}</div>
    </div>
    <p className={styles.finePrint}>One shared picture. Plan-first changes.<br />The same audited action boundary.</p>
  </Card>;
}

function OwnershipCard() {
  const [selected, select] = useState(1);
  const artifact = EXPORT_ARTIFACTS[selected];
  return <Card id="ownership" chapter="close" className={styles.ownershipCard}>
    <CardTitle id="ownership" label="Yours, all the way out">Your system.<br />Not our lock-in.</CardTitle>
    <div className={styles.exportFan} role="group" aria-label="Explore portable exports">
      {EXPORT_ARTIFACTS.map((item, index) => <button type="button" key={item.name} className={styles.exportSheet} style={{ "--sheet": index } as CSSProperties} aria-pressed={selected === index} onClick={() => select(index)}>
        <Glyph name="document" size={24} /><b>{item.name}</b><span aria-hidden="true" className={styles.paperLines}><i /><i /><i /></span>
      </button>)}
    </div>
    <div className={styles.exportCaption} role="status"><b>{artifact.file}</b><p>{artifact.description}</p></div>
  </Card>;
}

function ProvidersCard({ providers }: { providers: ProviderRow[] }) {
  const current = providers.filter((provider) => provider.availability !== "planned");
  const planned = providers.filter((provider) => provider.availability === "planned");
  return <Card id="cloud" chapter="cloud" className={styles.providersCard}>
    <div className={styles.providersCopy}><CardTitle id="cloud" label="Honesty is a feature" description="Available, simulated, preview, or planned. You should never have to guess.">Clear about<br />what’s real.</CardTitle><Link href="/guide" className={styles.textButton}>Explore the guide<Glyph name="arrow" size={17} /></Link></div>
    <div className={styles.providerList}>
      {current.map((provider) => {
        const presentation = providerPresentation(provider);
        return <div key={provider.id} className={styles.providerRow}>
          <div><b>{provider.displayName}</b><span className={styles.status} data-status={presentation.tone}><i aria-hidden="true" />{presentation.label}</span></div>
          <p>{presentation.description}</p>
        </div>;
      })}
      {!providers.length && <p>Provider status is unavailable here. Check the guide before planning a deployment.</p>}
      {!!planned.length && <details className={styles.plannedProviders}><summary>What’s planned?</summary>{planned.map((provider) => <p key={provider.id}><b>{provider.displayName} · Planned</b><span>{provider.tagline}</span></p>)}</details>}
      <p className={styles.vision}><b>Zenith-managed hosting · Product vision</b><br />Not an available hosting service.</p>
    </div>
  </Card>;
}

function TeamsCard() {
  const [selected, select] = useState(0);
  const story = TEAM_STORIES[selected];
  return <Card id="teams" className={styles.teamsCard}>
    <CardTitle id="teams" label="For teams like yours">Build the product.<br />Keep the overview.</CardTitle>
    <div className={styles.teamSwitch} role="group" aria-label="Explore team situations">{TEAM_STORIES.map((item, index) => <button type="button" key={item.name} aria-pressed={selected === index} onClick={() => select(index)}>{item.name}</button>)}</div>
    <div className={styles.teamStory} role="status"><p>{story.situation}</p><span className={styles.teamArrow}><Glyph name="arrow" size={22} /></span><p>{story.outcome}</p></div>
  </Card>;
}

/** One-shot entry motion; the readable server-rendered page never waits on animation. */
function useBentoEntrance(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const element = root.current;
    if (!element || typeof IntersectionObserver === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (media.matches) return;
    const animations: Animation[] = [];
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        if (!media.matches && typeof entry.target.animate === "function") animations.push(entry.target.animate(
          [{ opacity: 0.65, transform: "translateY(16px)" }, { opacity: 1, transform: "translateY(0)" }],
          { duration: 440, easing: "cubic-bezier(.2,.75,.25,1)" },
        ));
      });
    }, { threshold: 0.08 });
    element.querySelectorAll("[data-bento]").forEach((card) => observer.observe(card));
    const stop = () => { if (media.matches) { observer.disconnect(); animations.forEach((animation) => animation.cancel()); } };
    media.addEventListener("change", stop);
    return () => { observer.disconnect(); animations.forEach((animation) => animation.cancel()); media.removeEventListener("change", stop); };
  }, [root]);
}

/** Replit-inspired color blocking, Zenith-specific product proof. The hero is not part of this surface. */
export function BentoBody({ providers }: { providers: ProviderRow[] }) {
  const root = useRef<HTMLDivElement>(null);
  useBentoEntrance(root);
  return <div ref={root} className={styles.body}>
    <section id="statement" className={styles.intro} aria-labelledby="bento-title">
      <h2 id="bento-title">Meet <span>Zenith.</span></h2>
      <p>One workspace for the infrastructure behind your app.<br className={styles.desktopBreak} /> See the system. Preview the change. Decide what runs.</p>
    </section>
    <div className={styles.grid}>
      <SystemCard /><AgentCard /><PreviewCard /><AutonomyCard />
      <EstimateCard /><FoundationCard /><OwnershipCard />
      <ProvidersCard providers={providers} /><TeamsCard />
    </div>
    <p className={styles.bottomNote}>A clearer view of your cloud. A more considered next move.</p>
  </div>;
}

export function BentoClose({ cta }: { cta: Cta }) {
  return <section id="close" data-chapter="close" className={styles.close} aria-labelledby="bento-close-title">
    <div className={styles.closeMain}>
      <div><p className={styles.closeLabel}>Your cloud, in full view.</p><h2 id="bento-close-title">Make your next move<br /><em>a clear one.</em></h2><div className={styles.closeActions}><LandingCta cta={cta} /><Link href="/guide">Explore the guide<Glyph name="arrow" size={17} /></Link></div></div>
      <div className={styles.closeMark} aria-hidden="true"><OrbitMark size={220} /></div>
    </div>
    <footer className="zenith-footer"><a href="#main" aria-label="Zenith home"><Wordmark size={26} /></a><p>The next change, made tangible.</p><nav aria-label="Footer navigation"><Link href="/login">Sign in</Link><Link href="/guide">Guide</Link></nav></footer>
  </section>;
}
