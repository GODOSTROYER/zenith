"use client";

import { useRef } from "react";
import { useCta } from "./cta";
import { LandingExperienceProvider } from "./landing-experience";
import { LandingHeader } from "./landing-header";
import { SpaceHero } from "./space-hero";
import { NarrativeBody } from "./narrative-body";
import { CloseChapter } from "./close-chapter";
import { GimbalCompanion } from "./gimbal-companion";
import { useSheetHandoff } from "./landing-motion";
import { useLandingNavigation } from "./landing-navigation";
import "./landing.css";

export interface ProviderRow {
  id: string;
  displayName: string;
  availability: "available" | "preview" | "planned";
  tagline: string;
}

export function Landing({ providers }: { providers: ProviderRow[] }) {
  const cta = useCta();
  const paper = useRef<HTMLDivElement>(null);
  const ink = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  useSheetHandoff(paper, ink);
  useLandingNavigation(page);
  return (
    <LandingExperienceProvider>
      <div ref={page} className="zenith-landing">
        <a href="#main" className="zenith-skip">Skip to content</a>
        <LandingHeader cta={cta} />
        <main id="main">
          <SpaceHero cta={cta} />
          <div ref={paper} className="zenith-sheet" data-sheet>
            <span className="zenith-sheet-edge" data-sheet-edge aria-hidden="true" />
            <NarrativeBody providers={providers} />
            <span className="zenith-sheet-dim" data-sheet-dim aria-hidden="true" />
          </div>
          <div ref={ink} className="zenith-sheet zenith-sheet-ink zenith-ink" data-sheet-ink>
            <CloseChapter cta={cta} />
          </div>
        </main>
        <GimbalCompanion />
      </div>
    </LandingExperienceProvider>
  );
}
