"use client";

import { ArrowDown, ArrowUpRight, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { RevisionScene } from "./revision-scene";
import { LandingCta } from "./landing-cta";
import type { Cta } from "./cta";
import type { RevisionDemo } from "./use-revision-demo";
import { revisionLabel } from "./demo-fixture";

export function LandingHero({ cta, demo }: { cta: Cta; demo: RevisionDemo }) {
  const [tone, setTone] = useState<"light" | "dark">("light");
  useEffect(() => {
    const sync = () => setTone(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return (
    <section className="zenith-hero" aria-labelledby="zenith-title">
      <div className="zenith-hero-main">
        <div className="zenith-hero-copy">
          <h1 id="zenith-title">See the change.<br /><em>Before you ship.</em></h1>
          <p className="zenith-hero-description">Your application. Its infrastructure. The next change.<br className="zenith-desktop-break" /> Zenith is a local-first deployment and operations platform that puts the plan in your hands.</p>
          <div className="zenith-hero-actions"><LandingCta cta={cta} /><a href="#change-demo" className="zenith-text-link">Explore the change <ArrowDown size={16} aria-hidden="true" /></a></div>
          <p className="zenith-hero-note">Bring your own cloud. Keep your model.</p>
        </div>
        <figure className="zenith-hero-object" aria-label={`Interactive simulation: Atlas infrastructure, ${demo.isHistorical ? "historical " : ""}revision ${revisionLabel(demo.revision)}. ${demo.phase === "current" || demo.phase === "restored" ? "API and worker services." : demo.phase === "recorded" ? "API, queue and worker configuration recorded." : "A proposed queue connects the API and worker."}`}>
          <div className="zenith-object-topline"><span><span className="zenith-open-dot" />Interactive simulation</span><span>ATLAS / R{revisionLabel(demo.revision)}</span></div>
          <div className="zenith-hero-scene">
            <RevisionScene phase={demo.phase} selected={demo.selected} tone={tone} />
            <a href="#change-demo" className="zenith-object-label zenith-label-api" onClick={() => demo.select("atlas-api")}><span>Service</span>atlas-api</a>
            <a href="#change-demo" className="zenith-object-label zenith-label-worker" onClick={() => demo.select("atlas-worker")}><span>Service</span>atlas-worker</a>
            {demo.phase !== "current" && demo.phase !== "restored" && <a href="#change-demo" className="zenith-object-label zenith-label-queue" onClick={() => demo.select("atlas-jobs")}><span><Plus size={11} aria-hidden="true" />{demo.phase === "recorded" ? "Recorded queue" : "Proposed queue"}</span>atlas-jobs <ArrowUpRight size={13} aria-hidden="true" /></a>}
          </div>
          <figcaption><span>{demo.isHistorical ? "A retained revision, in view." : demo.phase === "recorded" ? "A new revision, recorded." : demo.phase === "restored" ? "Previous configuration, restored." : "The next change, made tangible."}</span><span>Synthetic example</span></figcaption>
        </figure>
      </div>
      <div className="zenith-hero-footer"><p>One queue. Two bindings.<br className="zenith-mobile-break" /> <em>A readable plan.</em></p><a href="#change-demo" aria-label="Inspect the Atlas example"><ArrowDown size={22} aria-hidden="true" /></a></div>
    </section>
  );
}
