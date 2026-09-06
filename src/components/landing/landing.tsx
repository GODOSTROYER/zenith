"use client";

import { useCta } from "./cta";
import { useRevisionDemo } from "./use-revision-demo";
import { LandingHeader } from "./landing-header";
import { LandingHero } from "./landing-hero";
import { ChangeDemo } from "./change-demo";
import { ModelSurfaces } from "./model-surfaces";
import { GimbalIntroduction } from "./gimbal-introduction";
import { ProviderChapter } from "./provider-chapter";
import { LandingClose } from "./landing-close";
import "./landing.css";

export interface ProviderRow {
  id: string;
  displayName: string;
  availability: "available" | "preview" | "planned";
  tagline: string;
}

/**
 * THESIS: The next change, made tangible. One physical system, one explicit action.
 * OWN-WORLD: Porcelain, ink, cut vermilion registers; editorial serif and precise evidence.
 * STORY: Inspect Atlas, review two bindings, explicitly simulate, retain the revision.
 * FIRST VIEWPORT: Monumental serif left; an exploded infrastructure object right; real CTA.
 * FORM: The Revision Object, selected from three internally challenged directions by brief.
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the finish
 * review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
 */
export function Landing({ providers }: { providers: ProviderRow[] }) {
  const cta = useCta();
  const demo = useRevisionDemo();
  return (
    <div className="zenith-landing">
      <a href="#main" className="zenith-skip">Skip to content</a>
      <LandingHeader cta={cta} />
      <main id="main">
        <LandingHero cta={cta} demo={demo} />
        <ChangeDemo demo={demo} />
        <ModelSurfaces demo={demo} />
        <GimbalIntroduction />
        <ProviderChapter providers={providers} />
        <LandingClose cta={cta} />
      </main>
    </div>
  );
}
