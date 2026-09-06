"use client";
import { Check } from "lucide-react";
import { cx } from "@/lib/format";
import { STEPS } from "./types";

export function Rail({ step, complete, hasWorkspace, hasChoice, onGo }: {
  step: number; complete: boolean[]; hasWorkspace: boolean; hasChoice: boolean; onGo: (n: number) => void;
}) {
  return <nav aria-label="Setup progress" className="h-fit shrink-0 border-b border-line pb-4 md:sticky md:top-8 md:w-[200px] md:border-b-0 md:pb-0">
    <ol className="grid grid-cols-4 gap-1 md:block md:space-y-1">{STEPS.map((s) => {
      const locked = s.n > 1 && !hasWorkspace ? "Choose a workspace first." : s.n === 3 && !hasChoice ? "Choose a provider explicitly first." : undefined;
      return <li key={s.n}><button type="button" disabled={!!locked} title={locked} aria-current={s.n === step ? "step" : undefined} onClick={() => onGo(s.n)} className={cx("flex min-h-11 w-full flex-col gap-2 rounded-ctl border px-2 py-3 text-left transition-colors duration-[var(--dur-fast)] disabled:opacity-50 md:flex-row md:gap-3 md:px-3", s.n === step ? "border-line-strong bg-bg2" : "border-transparent hover:bg-bg1")}>
        <span className={cx("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-[var(--r-pill)] border font-mono text-xs", complete[s.n - 1] ? "border-ok text-ok" : s.n === step ? "border-signal text-signal" : "border-line text-ink-faint")}>{complete[s.n - 1] ? <Check className="h-3 w-3" aria-label="Present in workspace" /> : s.n}</span>
        <span className="min-w-0"><span className="block text-xs text-ink md:text-sm">{s.title}</span><span className="mt-1 hidden text-xs text-ink-faint md:block">{s.hint}</span>{locked && <span className="mt-1 hidden text-xs text-ink-faint md:block">{locked}</span>}</span>
      </button></li>;
    })}</ol>
    <p className="mt-6 hidden border-t border-line px-3 pt-5 text-xs leading-relaxed text-ink-faint md:block">Set up at your own pace, or skip ahead to the guide. You can return whenever you need. Nothing is deployed during setup.</p>
  </nav>;
}
