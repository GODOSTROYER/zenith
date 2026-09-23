"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowDown } from "lucide-react";
import { ZENITH_LETTER_PATHS, ZENITH_SYMBOL_PATHS } from "@/components/shell/brand-geometry";
import { GlassCta } from "./landing-cta";
import type { Cta } from "./cta";
import { RIDGES, SCENE_HEIGHT, SCENE_WIDTH, SUMMIT } from "./hero-ridges";
import { useHeroScene } from "./landing-motion";
import { METEORS_EVENT, Starfield } from "./starfield";
import styles from "./space-hero.module.css";

/** The tools and targets Zenith works with. Availability is stated in the roadmap chapter, not here. */
const MARKS: { id: string; label: string; asset?: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "aws", label: "AWS", asset: "aws" },
  { id: "localstack", label: "LocalStack" },
  { id: "kubernetes", label: "Kubernetes", asset: "kubernetes-mono" },
  { id: "gcp", label: "Google Cloud", asset: "google-cloud" },
  { id: "azure", label: "Azure", asset: "azure" },
  { id: "oracle", label: "Oracle Cloud", asset: "oracle-mark" },
];

const VIEW_BOX = `0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`;
/** Letter spacing for the apex composition: each letter steps right by this many drawing units. */
const TRACK = 7;

/**
 * Two compositions share the sky. "apex" (the default): the lettering wide and
 * centred, the mark glowing at the top of the ray that rises from the summit.
 * "classic" (`?hero=classic`): the earlier
 * left-set opening with the mark on the summit.
 */
type Variant = "apex" | "classic";

/** The two words the tagline turns between, each held for a long while. */
const TAGLINE_WORDS = ["cloud", "infra"] as const;
const TAGLINE_DWELL_MS = 9000;

/**
 * "Your cloud, in full view." whose second word gives way to "infra" now and
 * then and comes back, slowly; the accessible text never changes. Still under
 * a reduced-motion preference.
 */
function Tagline() {
  const [word, setWord] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setWord((current) => (current + 1) % TAGLINE_WORDS.length), TAGLINE_DWELL_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <p className={styles.tagline} data-hero-seq data-enter="3" data-hero-fade>
      <span className="sr-only">Your cloud, in full view.</span>
      <span aria-hidden="true">Your <span className={styles.swap}>{TAGLINE_WORDS.map((candidate, index) => <span key={candidate} data-current={index === word || undefined}>{candidate},</span>)}</span><br />In full view.</span>
    </p>
  );
}

/** The star at the apex: an eight-point glint that glows now and then and, under the pointer or pressed, sends a wave of meteors across the sky. */
function ApexStar({ onPress, onHover }: { onPress: (star: HTMLButtonElement) => void; onHover: (star: HTMLButtonElement) => void }) {
  return (
    <button type="button" className={styles.apexStar} data-hero-apex aria-label="Send a wave of meteors across the sky" title="A wave of meteors" onClick={(event) => onPress(event.currentTarget)} onPointerEnter={(event) => { if (event.pointerType === "mouse") onHover(event.currentTarget); }}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path className={styles.spikeSoft} d="M32 4 C33.2 20, 44 30.8, 60 32 C44 33.2, 33.2 44, 32 60 C30.8 44, 20 33.2, 4 32 C20 30.8, 30.8 20, 32 4 Z" />
        <path className={styles.spike} d="M32 2 C33.5 21, 43 30.5, 62 32 C43 33.5, 33.5 43, 32 62 C30.5 43, 21 33.5, 2 32 C21 30.5, 30.5 21, 32 2 Z" />
        <circle className={styles.starCore} cx="32" cy="32" r="3.2" />
      </svg>
    </button>
  );
}

/** Keeps `--summit-bottom`, the far ridge's summit measured from the opening's bottom edge, in step with the scene's `xMidYMax slice` scale. */
function useSummitAnchor(section: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = section.current;
    if (!element) return;
    const place = () => {
      const scale = Math.max(element.clientWidth / SCENE_WIDTH, element.clientHeight / SCENE_HEIGHT);
      element.style.setProperty("--summit-bottom", `${((SCENE_HEIGHT - SUMMIT.y) * scale).toFixed(1)}px`);
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [section]);
}

export function SpaceHero({ cta }: { cta: Cta }) {
  const section = useRef<HTMLElement>(null);
  const [variant, setVariant] = useState<Variant>("apex");
  useEffect(() => { if (new URLSearchParams(window.location.search).get("hero") === "classic") setVariant("classic"); }, []);
  useHeroScene(section);
  useSummitAnchor(section);
  const apex = variant === "apex";
  const lastWave = useRef(0);
  const meteors = (star: HTMLButtonElement, count?: number) => {
    section.current?.dispatchEvent(new CustomEvent(METEORS_EVENT, { detail: { count } }));
    star.dataset.burst = "true";
    window.setTimeout(() => { delete star.dataset.burst; }, 1000);
    lastWave.current = Date.now();
  };
  /* A glance sends a smaller wave, at most once every few seconds; a press always sends the full one. */
  const glance = (star: HTMLButtonElement) => { if (Date.now() - lastWave.current > 4000) meteors(star, 4 + Math.floor(Math.random() * 3)); };
  return (
    <section ref={section} className={`zenith-hero ${styles.hero}`} data-chapter="hero" data-variant={variant} aria-labelledby="zenith-title">
      <div className={`${styles.layer} ${styles.sky}`} data-layer data-speed="0" aria-hidden="true" />
      <div className={`${styles.layer} ${styles.nebula}`} data-layer data-speed=".18" aria-hidden="true" />
      <div className={styles.layer} data-layer data-speed=".28" aria-hidden="true"><Starfield className={styles.stars} /></div>
      <div className={`${styles.layer} ${styles.glow}`} data-layer data-speed=".22" aria-hidden="true" />
      <div className={`${styles.layer} ${styles.haze}`} data-layer data-speed=".16" aria-hidden="true" />
      {RIDGES.map((ridge, index) => (
        <div key={ridge.id} className={`${styles.layer} ${styles.ridge}`} data-layer data-speed={ridge.speed} aria-hidden="true">
          <svg viewBox={VIEW_BOX} preserveAspectRatio="xMidYMax slice" className={styles.scene} data-ridge={ridge.id}>
            <defs>
              <radialGradient id={`ridge-light-${ridge.id}`} gradientUnits="userSpaceOnUse" cx={SUMMIT.x} cy={SUMMIT.y} r={index === 0 ? 560 : 900}>
                <stop offset="0" className={styles.lightNear} />
                <stop offset=".42" className={styles.lightMid} />
                <stop offset="1" className={styles.lightFar} />
              </radialGradient>
              <linearGradient id={`ridge-haze-${ridge.id}`} gradientUnits="userSpaceOnUse" x1="0" y1={ridge.summit} x2="0" y2={SCENE_HEIGHT}>
                <stop offset="0" className={styles.hazeTop} />
                <stop offset="1" className={styles.hazeBottom} />
              </linearGradient>
              {index === 0 && !apex && (
                <linearGradient id="beacon-ray" gradientUnits="userSpaceOnUse" x1="0" y1={SUMMIT.y} x2="0" y2={SUMMIT.y - 360}>
                  <stop offset="0" stopColor="#fff1e4" stopOpacity=".95" />
                  <stop offset=".45" stopColor="#ffd0b8" stopOpacity=".35" />
                  <stop offset="1" stopColor="#ffd0b8" stopOpacity="0" />
                </linearGradient>
              )}
            </defs>
            {/* rim light along the whole crest, then the body set a few units lower so only the crest stays lit */}
            <path d={ridge.fill} fill={`url(#ridge-light-${ridge.id})`} />
            <path d={ridge.fill} className={styles.body} transform={`translate(0 ${ridge.band})`} />
            <path d={ridge.fill} fill={`url(#ridge-haze-${ridge.id})`} className={styles.hazeFill} />
            <path d={ridge.crest} className={styles.crest} />
            {index === 0 && !apex && (
              <>
                <rect data-hero-beacon x={SUMMIT.x - 1.5} y={SUMMIT.y - 360} width="3" height="360" rx="1.5" fill="url(#beacon-ray)" className={styles.ray} />
                {/* the mark rests on the summit: its base a few units above the crest */}
                <g className={styles.summitMark} transform={`translate(${SUMMIT.x - 24} ${SUMMIT.y - 54}) scale(1.5)`}>{ZENITH_SYMBOL_PATHS.map((d) => <path key={d} d={d} />)}</g>
              </>
            )}
          </svg>
        </div>
      ))}
      {apex && (
        <div className={styles.apex}>
          <ApexStar onPress={(star) => meteors(star)} onHover={glance} />
          <i className={styles.apexRay} data-hero-beacon aria-hidden="true" />
        </div>
      )}
      <div className={`${styles.layer} ${styles.clouds}`} data-layer data-speed=".2" aria-hidden="true" />
      <div className={`${styles.layer} ${styles.dim}`} data-hero-dim aria-hidden="true" />
      <div className={styles.content}>
        {apex ? (
          <>
            <div className={styles.apexTop}>
              <div className={styles.lettering}>
                <p className={styles.welcome} data-hero-seq data-enter="1" data-hero-fade>Welcome to</p>
                <h1 id="zenith-title" className={`${styles.wordmark} ${styles.wordmarkWide}`} data-hero-wordmark>
                  <span className="sr-only">Zenith</span>
                  <svg viewBox={`0 0 ${256 + TRACK * (ZENITH_LETTER_PATHS.length - 1)} 66`} aria-hidden="true">
                    {ZENITH_LETTER_PATHS.map((d, index) => <g key={d} transform={`translate(${index * TRACK} 0)`}><path d={d} fillRule="evenodd" data-letter /></g>)}
                  </svg>
                </h1>
              </div>
            </div>
            <div className={styles.apexBottom}>
              <Tagline />
              <div className={styles.actions} data-hero-seq data-enter="3" data-hero-fade><GlassCta cta={cta} /></div>
            </div>
          </>
        ) : (
          <>
            <div className={styles.top}>
              <p className={styles.welcome} data-hero-seq data-enter="1" data-hero-fade>Welcome to</p>
              <h1 id="zenith-title" className={styles.wordmark} data-hero-wordmark>
                <span className="sr-only">Zenith</span>
                <svg viewBox="0 0 256 66" aria-hidden="true">{ZENITH_LETTER_PATHS.map((d) => <path key={d} d={d} fillRule="evenodd" data-letter />)}</svg>
              </h1>
            </div>
            <div className={styles.bottom}>
              <div className={styles.actions} data-hero-seq data-enter="3" data-hero-fade><GlassCta cta={cta} /><a href="#before" className={styles.ghost}>See the system <ArrowDown size={16} aria-hidden="true" /></a></div>
              <Tagline />
            </div>
          </>
        )}
        <ul className={styles.marks} aria-label="Works with">
          {MARKS.map((mark) => <li key={mark.id} data-brand={mark.id} data-hero-mark data-enter="4">{mark.asset ? <Image src={`/cloud-logos/${mark.asset}.svg`} alt={mark.label} width={72} height={30} unoptimized /> : <span>{mark.label}</span>}</li>)}
        </ul>
      </div>
      <a href="#statement" className={styles.scrollCue} aria-label="Scroll to the next section"><ArrowDown size={18} aria-hidden="true" /></a>
    </section>
  );
}
