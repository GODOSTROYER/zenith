"use client";
import { useRef, type KeyboardEvent } from "react";
import { CornerDownLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cx } from "@/lib/format";
import { NavigatorGlyph, type GimbalState } from "./glyph";

export const EXAMPLE_GOALS = [
  "Add a redis cache and bind it to web, then deploy to staging",
  "Set a $100 budget on staging and fix the security findings",
  "Investigate the failed deployment",
];

export interface CommandBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  gimbalState?: GimbalState | null;
  /** set when the field cannot be submitted; becomes the button's tooltip */
  disabledReason?: string;
  showExamples?: boolean;
}

/** The Navigator's one input. Enter plans; nothing here executes. */
export function CommandBar({
  value,
  onChange,
  onSubmit,
  busy,
  gimbalState = null,
  disabledReason,
  showExamples = true,
}: CommandBarProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabledReason && !busy) onSubmit();
    }
  };

  const fill = (goal: string) => {
    onChange(goal);
    ref.current?.focus();
  };

  return (
    <div>
      <label htmlFor="navigator-request" className="mb-2 block text-[13px] font-semibold text-ink">Your request</label>
      <div
        className={cx(
          "flex flex-wrap items-start gap-3 rounded-card border border-line-strong bg-bg2 px-4 py-4",
          "transition-colors duration-[var(--dur-fast)] [transition-timing-function:var(--ease-swift)]",
          "focus-within:border-nav-accent/60"
        )}
      >
        <NavigatorGlyph size={22} state={gimbalState} className="mt-[2px] text-nav-accent" />
        <textarea
          id="navigator-request"
          ref={ref}
          rows={2}
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={keyDown}
          placeholder="Tell the Navigator what you want…"
          aria-label="Goal for the Navigator"
          className={cx(
            "min-w-[160px] flex-1 resize-y bg-transparent font-sans text-[14px] leading-6 text-ink outline-none",
            "placeholder:font-sans placeholder:text-[14px] placeholder:text-ink-faint"
          )}
        />
        <div className="flex shrink-0 flex-col items-end gap-2">
          <Button
            variant="primary"
            onClick={onSubmit}
            busy={busy}
            disabled={Boolean(disabledReason) || !value.trim()}
            disabledReason={
              disabledReason ?? "Describe what you want first — the Navigator plans from a goal."
            }
            icon={<CornerDownLeft className="h-3.5 w-3.5" />}
          >
            Plan
          </Button>
          <span className="hidden items-center gap-1 text-[11.5px] text-ink-faint sm:flex">
            <Kbd>Enter</Kbd> to plan
          </span>
        </div>
      </div>

      {showExamples && <details className="mt-3 text-[12px] text-ink-mute">
        <summary className="min-h-8 cursor-pointer py-1">Example requests</summary>
      <div className="mt-1 flex flex-col items-start gap-1">
        {EXAMPLE_GOALS.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => fill(g)}
            className={cx(
              "min-h-8 border-l-2 border-line px-3 py-1 text-left text-[12px] text-ink-mute",
              "transition-colors duration-[var(--dur-fast)] [transition-timing-function:var(--ease-swift)]",
              "hover:border-nav-accent/40 hover:bg-nav-dim hover:text-ink"
            )}
          >
            {g}
          </button>
        ))}
      </div></details>}
    </div>
  );
}
