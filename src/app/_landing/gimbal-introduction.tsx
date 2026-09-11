"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Circle, CirclePause, CircleX, LoaderCircle, ScanEye, Sparkles } from "lucide-react";
import { GimbalCharacter } from "@/components/navigator/gimbal-character";
import { AUTONOMY_LEVELS, AUTONOMY_MEANING } from "@/lib/navigator/shared";
import type { AutonomyLevel } from "@/lib/domain/types";

const STATES = [
  { label: "Planning", description: "Preparing a typed plan.", icon: Sparkles, state: "planning" },
  { label: "Awaiting approval", description: "Holding for your decision.", icon: CirclePause, state: "awaiting_approval" },
  { label: "Applying", description: "Running an approved action.", icon: LoaderCircle, state: "applying" },
  { label: "Verified", description: "Authoritative, non-simulated provider evidence confirms the result.", icon: ScanEye, state: "verified" },
  { label: "Blocked", description: "A problem needs attention.", icon: CircleX, state: "blocked" },
  { label: "Neutral", description: "Ready, plan complete, simulation complete, or cancelled.", icon: Circle, state: "neutral" },
];

/** Gimbal remains a neutral companion; its greeting is never evidence of a run. */
export function GimbalIntroduction() {
  const [level, setLevel] = useState<AutonomyLevel>("approve");
  return (
    <section id="meet-gimbal" className="zenith-gimbal" aria-labelledby="meet-gimbal-title">
      <div className="zenith-gimbal-main">
        <figure className="zenith-gimbal-figure">
          <div className="zenith-gimbal-orbit-caption"><span>GIMBAL</span><span>Ready to help</span></div>
          <GimbalCharacter state={null} className="zenith-gimbal-character" />
          <figcaption>Hello. I’m Gimbal.</figcaption>
        </figure>
        <div className="zenith-gimbal-copy">
          <h2 id="meet-gimbal-title">An intent. A plan.<br /><em>Your decision.</em></h2>
          <p>Navigator turns what you want into typed, reviewable actions. Gimbal is your companion along the way: a visible expression of what’s happening, and when it needs you.</p>
          <p>Both use the same model you just explored. The same resources. The same approval boundaries. Every action leaves a record.</p>
          <div className="zenith-gimbal-links"><Link href="/onboarding?step=1" className="zenith-text-link">Start with Gimbal <ArrowUpRight size={16} aria-hidden="true" /></Link><Link href="/guide" className="zenith-subtle-link">Open workspace guide</Link></div>
        </div>
      </div>
      <div className="zenith-autonomy">
        <div><h3>How much initiative?<br /><em>You set the boundary.</em></h3><p>Explore the five autonomy levels. Deployment approval policies and budgets still apply.</p></div>
        <div className="zenith-autonomy-explorer">
          <div className="zenith-autonomy-levels" role="group" aria-label="Explore Navigator autonomy levels">
            {AUTONOMY_LEVELS.map((value, index) => <button type="button" key={value} aria-pressed={value === level} onClick={() => setLevel(value)}><span>{index + 1}</span>{value}</button>)}
          </div>
          <p aria-live="polite">{AUTONOMY_MEANING[level]}</p>
          <span className="zenith-autonomy-note">Policy explanations · no workspace setting is changed</span>
        </div>
      </div>
      <details className="zenith-state-guide"><summary>How Gimbal communicates state <span aria-hidden="true">+</span></summary><div className="zenith-state-grid">{STATES.map(({ label, description, icon: Icon, state }) => <div key={state} data-gimbal-state={state}><h4><Icon size={17} aria-hidden="true" />{label}</h4><p>{description}</p></div>)}</div><p>A simulation or completed plan is not a verified deployment. State always comes with a label and an icon.</p></details>
    </section>
  );
}
