"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { GIMBAL_STATES, type GimbalState } from "./gimbal-contract";
import { GimbalCharacter, type GimbalMotion } from "./gimbal-character";
import { GimbalStatus } from "./gimbal-status";

const DESCRIPTION: Record<GimbalState, string> = {
  planning: "A focused gaze. The rings gently explore different orientations.",
  awaiting_approval: "An open, attentive expression. A calm orbit while the decision is yours.",
  applying: "A little more focus and momentum, with the same quiet rhythm.",
  verified: "A small smile. The rings ease back into their unhurried orbit.",
  blocked: "A thoughtful expression. The orbit softens while something needs attention.",
};

/** Preview controls never create or modify a Navigator run. */
export function GimbalPreview() {
  const [state, setState] = useState<GimbalState>("planning");
  const [motion, setMotion] = useState<GimbalMotion>("auto");
  return (
    <main className="mx-auto max-w-[960px] px-5 py-8 text-ink sm:px-8 sm:py-12">
      <header className="border-b border-line pb-6">
        <h1 className="text-[28px] font-semibold tracking-tight">Gimbal</h1>
        <p className="mt-1 text-[14px] text-ink-mute">A quiet presence, always in orbit.</p>
      </header>
      <section aria-labelledby="gimbal-preview-title" className="py-7">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 id="gimbal-preview-title" className="text-[20px] font-medium">State preview</h2>
          <SegmentedControl<GimbalMotion> label="Character motion" value={motion} onChange={setMotion}
            options={[{ value: "auto", label: "Automatic" }, { value: "still", label: "Still" }, { value: "low-power", label: "Low power" }]} />
        </div>
        <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="Preview workflow state">
          {GIMBAL_STATES.map((option) => (
            <Button key={option} variant={state === option ? "quiet" : "ghost"} aria-pressed={state === option} onClick={() => setState(option)}>
              <GimbalStatus state={option} />
            </Button>
          ))}
        </div>
        <div className="mt-6 grid items-center gap-6 border-y border-line py-6 sm:grid-cols-[minmax(0,1.2fr)_minmax(220px,0.8fr)] sm:gap-10">
          <figure className="mx-auto w-full max-w-[400px]">
            <GimbalCharacter state={state} motion={motion} />
            <figcaption className="text-center text-[12px] text-ink-faint">Hover for a glance. Tap for a little hello.</figcaption>
          </figure>
          <div aria-live="polite" aria-atomic="true">
            <GimbalStatus state={state} />
            <p className="mt-3 max-w-[36ch] text-[14px] leading-relaxed text-ink-mute">{DESCRIPTION[state]}</p>
          </div>
        </div>
        <p className="mt-4 max-w-[72ch] text-[12px] leading-relaxed text-ink-faint">
          Choose a state to feel the orbit shift, then settle. Still mode respects a preference for less motion.
          These controls only preview Gimbal; they do not run actions.
        </p>
      </section>
    </main>
  );
}
