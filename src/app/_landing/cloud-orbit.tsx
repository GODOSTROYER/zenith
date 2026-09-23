"use client";

import Image from "next/image";
import { useRef } from "react";
import { ArrowUpRight, Plus } from "lucide-react";
import { ZENITH_SYMBOL_PATHS } from "@/components/shell/brand-geometry";
import type { ProviderRow } from "./landing";
import { useHighlight } from "./landing-experience";
import { useOrbitMotion } from "./landing-motion";
import styles from "./cloud-orbit.module.css";

const CLOUDS = [
  { id: "aws", name: "AWS", asset: "aws", position: "aws" },
  { id: "gcp", name: "Google Cloud", asset: "google-cloud", position: "google" },
  { id: "azure", name: "Azure", asset: "azure", position: "azure" },
  { id: "kubernetes", name: "Kubernetes", asset: "kubernetes", position: "kubernetes" },
  { id: "oracle", name: "Oracle Cloud", asset: "oracle", position: "oracle" },
] as const;

const CURRENT: Record<string, string> = {
  sandbox: "Try a practice environment. Changes are simulated, so no cloud resources are created.",
  localstack: "Try supported storage and queue operations locally. Other operations remain simulated.",
  aws: "Prepare plans and download them for use with your own tools. Connecting to or deploying into an AWS account is not available yet.",
};

function ZenithSymbol({ className }: { className?: string }) {
  return <svg className={className} viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">{ZENITH_SYMBOL_PATHS.map((path) => <path key={path} d={path} />)}</svg>;
}

/**
 * The cloud roadmap constellation, kept as designed: one Zenith core, five
 * clouds on their orbits with the registry's availability beside each mark,
 * and the managed path shown as a product vision rather than a service.
 */
export function CloudOrbit({ providers }: { providers: ProviderRow[] }) {
  const current = providers.filter((provider) => provider.availability !== "planned");
  const highlight = useHighlight("cloud");
  const details = useRef<HTMLDetailsElement>(null);
  const figure = useRef<HTMLElement>(null);
  useOrbitMotion(figure);
  const hot = highlight?.region;
  const card = (id: string) => ({ "data-hot": hot === id || undefined, "data-soft": hot && hot !== id ? true : undefined });
  const openRoadmap = () => {
    const element = details.current;
    if (!element) return;
    element.open = true;
    element.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    element.querySelector<HTMLElement>("summary")?.focus();
  };
  return (
    <section id="cloud" data-chapter="cloud" className={`zenith-ink ${styles.chapter}`} aria-labelledby="zenith-cloud-title">
      <div className={styles.inner}>
        <div className={styles.copy} data-reveal>
          <h2 id="zenith-cloud-title">Your cloud.<br /><em>Your call.</em></h2>
          <p>Your system should grow on your terms. We’re building toward a choice: bring your cloud, or let Zenith take care of the hosting.</p>
          <p className={styles.promise}>One place to see the whole picture.<br />The freedom to choose what’s next.</p>
          <button type="button" className={styles.link} onClick={openRoadmap}>Explore the cloud roadmap <ArrowUpRight size={16} aria-hidden="true" /></button>
        </div>
        <figure ref={figure} className={styles.constellation} aria-label="Zenith cloud roadmap">
          <svg className={styles.orbits} viewBox="0 0 600 520" preserveAspectRatio="none" fill="none" aria-hidden="true">
            <ellipse cx="300" cy="260" rx="235" ry="173" transform="rotate(-22 300 260)" />
            <ellipse cx="300" cy="260" rx="157" ry="232" transform="rotate(-38 300 260)" />
            <path d="M156 104 300 260 450 94M78 276 300 260 516 265M162 426 300 260 444 432" />
          </svg>
          <div className={styles.core} data-orbit-core><ZenithSymbol /><span>Zenith</span></div>
          {CLOUDS.map((cloud) => {
            const availability = providers.find((provider) => provider.id === cloud.id)?.availability;
            const status = cloud.id === "oracle" ? "Planned · later" : availability === "preview" ? "Preview" : availability === "available" ? "Available" : "Planned";
            return <div className={`${styles.cloud} ${styles[cloud.position]}`} key={cloud.id} data-orbit-card {...card(cloud.id)}>
              <Image className={`${styles.brand} ${cloud.id === "aws" ? styles.awsBrand : ""} ${cloud.id === "oracle" ? styles.oracleBrand : ""}`} src={`/cloud-logos/${cloud.asset}.svg`} width={72} height={40} alt="" unoptimized />
              <strong>{cloud.name}</strong><span className={availability === "preview" ? styles.preview : undefined}>{status}</span>
            </div>;
          })}
          <div className={`${styles.cloud} ${styles.managed}`} data-orbit-card {...card("managed")}><ZenithSymbol className={styles.managedMark} /><strong>Zenith-managed</strong><span>Product vision</span></div>
          <figcaption>Cloud choice is the destination.<br />AWS is in Preview. More possibilities ahead.</figcaption>
        </figure>
        <details ref={details} className={styles.disclosure}>
          <summary><span>What can I use today?</span><Plus size={18} aria-hidden="true" /></summary>
          <div className={styles.capabilities}>{current.map((provider) => <p key={provider.id}><strong>{provider.displayName}{provider.availability === "preview" && !provider.displayName.toLowerCase().includes("preview") ? " Preview" : ""}.</strong> {CURRENT[provider.id] ?? provider.tagline}</p>)}<p>Google Cloud, Azure, and Kubernetes are planned. Oracle Cloud is a later possibility. Zenith-managed hosting is a product vision, not an available service. Through Claude Code or Codex, phase-1 deployments run on the simulated sandbox.</p></div>
        </details>
      </div>
    </section>
  );
}
