"use client";

import { useRef } from "react";
import { useCta } from "./cta";
import { LandingExperienceProvider } from "./landing-experience";
import { LandingHeader } from "./landing-header";
import { SpaceHero } from "./space-hero";
import { Facts, Statement } from "./statement";
import { BeforeChapter } from "./before-chapter";
import { ScenarioChapter } from "./scenario-chapter";
import { AgentsChapter } from "./agents-chapter";
import { GimbalChapter } from "./gimbal-chapter";
import { CloudOrbit } from "./cloud-orbit";
import { CloseChapter } from "./close-chapter";
import { GimbalCompanion } from "./gimbal-companion";
import { useSheetHandoff } from "./landing-motion";
import "./landing.css";

export interface ProviderRow {
  id: string;
  displayName: string;
  availability: "available" | "preview" | "planned";
  tagline: string;
}

/**
 * THESIS: Your cloud, in full view. The sky at its zenith, then the system underneath it.
 * OWN-WORLD: Night sky, nebula and horizon glow at both ends; porcelain daylight in between;
 * the brand lettering as the opening statement; Gimbal at home in the corner.
 * STORY: Welcome → one sentence → the real facts → the system → growth → your agents →
 * your control → your cloud → reach the zenith.
 * FIRST VIEWPORT: The wordmark across the sky, the real CTA, the marks Zenith works with.
 * FORM: Few words, big rounded cards, one shared state, motion that reveals rather than decorates.
 */
export function Landing({ providers }: { providers: ProviderRow[] }) {
  const cta = useCta();
  const paper = useRef<HTMLDivElement>(null);
  const ink = useRef<HTMLDivElement>(null);
  useSheetHandoff(paper, ink);
  return (
    <LandingExperienceProvider>
      <div className="zenith-landing">
        <a href="#main" className="zenith-skip">Skip to content</a>
        <LandingHeader cta={cta} />
        <main id="main">
          <SpaceHero cta={cta} />
          {/* After the opening come two raised sheets, each sliding over what precedes it as it recedes and darkens:
              the porcelain over the sky, then the ink over the porcelain. */}
          <div ref={paper} className="zenith-sheet" data-sheet>
            <span className="zenith-sheet-edge" data-sheet-edge aria-hidden="true" />
            <Statement />
            <Facts />
            <BeforeChapter />
            <ScenarioChapter />
            <AgentsChapter />
            <GimbalChapter />
            <span className="zenith-sheet-dim" data-sheet-dim aria-hidden="true" />
          </div>
          <div ref={ink} className="zenith-sheet zenith-sheet-ink zenith-ink" data-sheet-ink>
            <CloudOrbit providers={providers} />
            <CloseChapter cta={cta} />
          </div>
        </main>
        <GimbalCompanion />
      </div>
    </LandingExperienceProvider>
  );
}
