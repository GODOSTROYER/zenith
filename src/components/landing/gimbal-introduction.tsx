"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { GimbalCharacter, type GimbalMotion } from "@/components/navigator/gimbal-character";

/** A neutral greeting, never a simulated workflow or a success claim. */
export function GimbalIntroduction() {
  const [motion, setMotion] = useState<GimbalMotion>("low-power");
  return (
    <section id="meet-gimbal" aria-labelledby="meet-gimbal-title" className="scroll-mt-20 border-y border-line bg-bg1">
      <div className="mx-auto grid max-w-[1180px] items-center gap-10 px-6 py-20 md:grid-cols-[280px_minmax(0,1fr)] lg:gap-20 lg:py-28">
        <figure className="mx-auto w-full max-w-[280px]">
          <GimbalCharacter state={null} motion={motion} className="h-[260px] w-full" />
          <figcaption className="text-center text-[14px] text-ink-mute">Hello. I’m Gimbal.</figcaption>
          <div className="mt-4 flex items-center justify-center gap-2 text-[12px] text-ink-faint">
            <label htmlFor="landing-gimbal-motion">Motion</label>
            <select id="landing-gimbal-motion" value={motion} onChange={(e) => setMotion(e.target.value as GimbalMotion)}
              className="ui-select min-h-9 rounded-ctl border border-line bg-bg2 px-2 text-ink">
              <option value="low-power">Low power</option><option value="still">Still poses</option><option value="auto">Follow system</option>
            </select>
          </div>
        </figure>
        <div>
          <h2 id="meet-gimbal-title" className="max-w-[22ch] text-balance text-[clamp(28px,4vw,44px)] font-bold leading-[1.08] tracking-[-0.02em]">Meet Gimbal, your Navigator.</h2>
          <p className="mt-5 max-w-[60ch] text-[16px] leading-[1.7] text-ink-mute">Gimbal helps you turn an intent into a reviewable plan. It uses the same actions as the rest of Zenith.ai, shows the next step, and pauses where your approval is required.</p>
          <p className="mt-4 max-w-[60ch] text-[14px] leading-[1.7] text-ink-mute">Start with a workspace, choose your connection, then build an editable system from a blueprint. Your guide stays available as you explore—no pop-up tour to remember.</p>
          <dl className="mt-7 grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2">
            <div><dt className="font-medium text-nav-accent">Planning</dt><dd className="mt-0.5 text-ink-mute">Preparing the next steps.</dd></div>
            <div><dt className="font-medium text-warn">Awaiting approval</dt><dd className="mt-0.5 text-ink-mute">Waiting for your decision.</dd></div>
            <div><dt className="font-medium text-info">Applying</dt><dd className="mt-0.5 text-ink-mute">An approved action is running.</dd></div>
            <div><dt className="font-medium text-ok">Verified</dt><dd className="mt-0.5 text-ink-mute">Supported provider checks confirm the result.</dd></div>
            <div><dt className="font-medium text-err">Blocked</dt><dd className="mt-0.5 text-ink-mute">A problem needs attention.</dd></div>
          </dl>
          <p className="mt-4 text-[12px] leading-relaxed text-ink-faint">Color always comes with a label. A simulation or completed plan is not a verified deployment.</p>
          <Link href="/onboarding?step=1" className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-ctl bg-signal px-5 text-[14px] font-semibold text-on-signal">Start with Gimbal <ArrowRight aria-hidden="true" className="h-4 w-4" /></Link>
          <Link href="/guide" className="ml-4 mt-4 inline-flex min-h-11 items-center text-[14px] text-ink-mute underline underline-offset-4 hover:text-ink">Open workspace guide</Link>
        </div>
      </div>
    </section>
  );
}
