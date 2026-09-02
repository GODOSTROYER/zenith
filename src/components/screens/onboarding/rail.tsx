"use client";
/** The setup progress rail — the only place a step can be jumped back to. */
import { Check } from "lucide-react";
import { cx } from "@/lib/format";
import { STEPS } from "./types";

/** Why a rail step is not reachable yet — no disabled control is ever silent. */
const RAIL_LOCKED: Record<number, string> = {
  2: "Name your workspace first — the provider step needs somewhere to put the connection.",
  3: "Pick where you will run first. Step 3 creates the project against that choice.",
};

export interface RailProps {
  step: number;
  onGo: (n: number) => void;
}

export function Rail({ step, onGo }: RailProps) {
  return (
    <nav aria-label="Setup progress" className="sticky top-12 hidden h-fit w-[212px] shrink-0 md:block">
      <ol className="space-y-1">
        {STEPS.map((s) => {
          const state = s.n < step ? "done" : s.n === step ? "current" : "todo";
          const locked = state === "todo" ? RAIL_LOCKED[s.n] : undefined;
          return (
            <li key={s.n}>
              <button
                type="button"
                onClick={() => onGo(s.n)}
                disabled={state === "todo"}
                title={locked ?? (state === "done" ? `Go back to: ${s.title}` : undefined)}
                aria-describedby={locked ? `rail-locked-${s.n}` : undefined}
                className={cx(
                  "flex w-full items-start gap-3 rounded-ctl px-3 py-2.5 text-left transition-colors duration-[var(--dur-fast)]",
                  state === "current" ? "bg-bg2" : "hover:bg-bg1",
                  state === "todo" && "cursor-default"
                )}
              >
                <span
                  className={cx(
                    "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px]",
                    state === "done" && "border-signal bg-signal text-on-signal",
                    state === "current" && "border-signal text-signal",
                    state === "todo" && "border-line text-ink-faint"
                  )}
                >
                  {state === "done" ? <Check className="h-3 w-3" /> : s.n}
                </span>
                <span className="min-w-0">
                  <span
                    className={cx(
                      "block text-[13px]",
                      state === "todo" ? "text-ink-faint" : "text-ink"
                    )}
                  >
                    {s.title}
                  </span>
                  <span className="block text-[12px] text-ink-faint">{s.hint}</span>
                  {locked && (
                    <span
                      id={`rail-locked-${s.n}`}
                      className="mt-1 block text-[11.5px] leading-relaxed text-ink-faint"
                    >
                      {locked}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mt-8 border-t border-line px-3 pt-5 text-[12px] leading-relaxed text-ink-faint">
        Nothing is created until the last step — not the project, not the environment, not the
        cloud connection. Leave at any point and no cost is left behind.
      </p>
    </nav>
  );
}
