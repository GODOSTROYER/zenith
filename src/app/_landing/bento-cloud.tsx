"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import type { ProviderRow } from "./landing";
import { providerPresentation } from "./bento-data";
import { Glyph } from "./bento-visuals";
import { useHighlight } from "./landing-experience";
import { CLOUD_BRANDS, CloudLogo, ManagedHostingVisual, MulticloudVisual } from "./bento-cloud-visuals";
import { useCloudMotion } from "./bento-cloud-motion";
import styles from "./bento-cloud.module.css";

function ProviderDetails({ providers, selected, detailsRef }: { providers: ProviderRow[]; selected: string | null; detailsRef: RefObject<HTMLDetailsElement | null> }) {
  const local = providers.filter((provider) => provider.id === "sandbox" || provider.id === "localstack");
  const cloud = providers.filter((provider) => provider.id !== "sandbox" && provider.id !== "localstack");
  const row = (provider: ProviderRow) => {
    const presentation = providerPresentation(provider);
    return <div className={styles.providerRow} key={provider.id} data-micro-provider={provider.id} data-selected={selected === provider.id} tabIndex={-1}>
      <div className={styles.rowLogo}><CloudLogo id={provider.id} /></div>
      <div><div className={styles.providerHeading}><b>{provider.displayName}</b><span className={styles.status} data-status={presentation.tone}>{presentation.label}</span></div><p>{presentation.description}</p></div>
    </div>;
  };
  return <details ref={detailsRef} id="bento-provider-details" className={styles.details} data-micro-details>
    <summary><span>Provider details</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></summary>
    <div className={styles.detailsBody} data-micro-disclosure>
      {providers.length === 0 && <p>Provider status is unavailable here. Check the guide before planning a deployment.</p>}
      {cloud.length > 0 && <div><h4>Cloud providers & deployment options</h4>{cloud.map(row)}</div>}
      {local.length > 0 && <div><h4>Local development</h4>{local.map(row)}</div>}
      <p className={styles.managedDetail}><b>Zenith-managed hosting · In development</b><br />Managed hosting and cross-cloud placement are the direction we’re building, not available hosting services. Logos identify cloud options, not partnerships.</p>
      <Link href="/guide" className={styles.detailLink} data-micro-action>Read the guide<Glyph name="arrow" size={15} /></Link>
    </div>
  </details>;
}

/** A focused replacement for the status-heavy panel; the rest of the bento stays intact. */
export function BentoCloudCluster({ providers, children }: { providers: ProviderRow[]; children: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const [paused, setPaused] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const highlight = useHighlight("cloud");
  useCloudMotion(root);
  const inspect = (id: string) => {
    const disclosure = details.current;
    if (!disclosure) return;
    setSelected(id);
    disclosure.open = true;
    // The rows already exist inside native details. Focus the real information, not a tooltip.
    const row = Array.from(disclosure.querySelectorAll<HTMLElement>("[data-micro-provider]")).find((element) => element.dataset.microProvider === id);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
  };
  return <section ref={root} id="cloud" data-chapter="cloud" data-cloud-motion="still" data-user-paused={paused}
    className={styles.cluster} aria-labelledby="hosting-title">
    <article id="hosting" data-bento data-chapter="cloud" data-hot={highlight?.region === "managed" || undefined} className={`${styles.card} ${styles.managedCard}`} aria-labelledby="hosting-title">
      <div className={styles.managedCopy}>
        <div className={styles.eyebrow}><span>Zenith-managed hosting</span><span className={styles.development}>In development</span></div>
        <h3 id="hosting-title">You build it.<br /><span>Zenith runs it.</span></h3>
        <p>The managed path we’re building: go from app to running system without taking on the infrastructure management.</p>
        <ul className={styles.benefits} aria-label="Managed hosting direction"><li>Managed operations</li><li>One workspace</li><li>Portable by design</li></ul>
        <Link href="/guide" className={styles.managedLink} data-micro-action>Explore managed hosting<Glyph name="arrow" size={17} /></Link>
      </div>
      <ManagedHostingVisual />
      <button type="button" className={styles.motionControl} aria-controls="cloud-managed-visual cloud-multicloud-visual"
        aria-label={paused ? "Play hosting animations" : "Pause hosting animations"} title={paused ? "Play animations" : "Pause animations"}
        onClick={() => setPaused((value) => !value)}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">{paused ? <path d="m5 3 8 5-8 5V3Z" /> : <path d="M4 3h3v10H4zM9 3h3v10H9z" />}</svg>
      </button>
    </article>
    <article id="multicloud" data-bento data-chapter="cloud" className={`${styles.card} ${styles.multicloudCard}`} aria-labelledby="multicloud-title">
      <div className={styles.eyebrow}><span>Multicloud possibilities</span><span className={styles.concept}>Concept</span></div>
      <h3 id="multicloud-title">Different clouds.<br />One clear system.</h3>
      <p>The direction: combine compute, storage, and services across clouds around what your workload needs.</p>
      <MulticloudVisual />
      <p className={styles.multiClosing}>More choice. One place to understand it.</p>
    </article>
    <article id="cloud-ecosystem" data-bento data-chapter="cloud" className={`${styles.card} ${styles.ecosystemCard}`} aria-labelledby="ecosystem-title">
      <header className={styles.ecosystemHeader}><div><h3 id="ecosystem-title">Your cloud options, together.</h3><p>One product direction. More ways to build.</p></div><span className={styles.roadmap}>Cloud roadmap</span></header>
      <ul className={styles.logoCollection} aria-label="Cloud roadmap and deployment options">
        {CLOUD_BRANDS.filter((brand) => brand.id !== "localstack").map((brand) => {
          const provider = providers.find((item) => (item.id === "oracle-coming-later" ? "oracle" : item.id) === brand.id);
          return <li key={brand.id} data-hot={highlight?.region === brand.id || undefined}>
            {provider ? <button type="button" data-micro-logo aria-controls="bento-provider-details" aria-pressed={selected === provider.id} aria-label={`Read ${brand.name} provider details`} onClick={() => inspect(provider.id)}>
              <div className={styles.logoFrame}><CloudLogo id={brand.id} /></div><span>{brand.name}</span>
            </button> : <><div className={styles.logoFrame}><CloudLogo id={brand.id} /></div><span>{brand.name}</span></>}
          </li>;
        })}
      </ul>
      <ProviderDetails providers={providers} selected={selected} detailsRef={details} />
    </article>
    <div className={styles.teamSlot}>{children}</div>
  </section>;
}
