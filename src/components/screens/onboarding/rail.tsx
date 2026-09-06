"use client";
import { Check } from "lucide-react";
import { cx } from "@/lib/format";
import { STEPS } from "./types";

export function Rail({ step, complete, hasWorkspace, hasChoice, onGo }: {
  step: number; complete: boolean[]; hasWorkspace: boolean; hasChoice: boolean; onGo: (n: number) => void;
}) {
  return <nav aria-label="Setup progress" className="sticky top-12 hidden h-fit w-[212px] shrink-0 md:block">
    <ol className="space-y-2">{STEPS.map((s) => {
      const locked = s.n > 1 && !hasWorkspace ? "Choose a workspace first." : s.n === 3 && !hasChoice ? "Choose a provider explicitly first." : undefined;
      return <li key={s.n}><button type="button" disabled={!!locked} title={locked} aria-current={s.n === step ? "step" : undefined} onClick={() => onGo(s.n)} className={cx("flex w-full gap-3 rounded-ctl px-3 py-3 text-left disabled:opacity-50", s.n === step ? "bg-bg2" : "hover:bg-bg1")}>
        <span className={cx("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-xs", complete[s.n - 1] ? "border-signal text-signal" : "border-line text-ink-faint")}>{complete[s.n - 1] ? <Check className="h-3 w-3" aria-label="Present in workspace" /> : s.n}</span>
        <span><span className="block text-sm text-ink">{s.title}</span><span className="mt-1 block text-xs text-ink-faint">{s.hint}</span>{locked && <span className="mt-1 block text-xs text-ink-faint">{locked}</span>}</span>
      </button></li>;
    })}</ol>
    <p className="mt-6 border-t border-line px-3 pt-5 text-xs leading-relaxed text-ink-faint">Set up at your own pace, or skip ahead to the guide. You can return whenever you need. Nothing is deployed during setup.</p>
  </nav>;
}
