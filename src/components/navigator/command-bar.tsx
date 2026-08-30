"use client";
import { useRef, type KeyboardEvent } from "react";
import { CornerDownLeft } from "lucide-react";
import { Button, Kbd } from "@/components/ui";
import { cx } from "@/lib/format";
import { NavigatorGlyph } from "./glyph";

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
  /** set when the field cannot be submitted; becomes the button's tooltip */
  disabledReason?: string;
}

/** The Navigator's one input. Enter plans; nothing here executes. */
export function CommandBar({ value, onChange, onSubmit, busy, disabledReason }: CommandBarProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabledReason) onSubmit();
    }
  };

  const fill = (goal: string) => {
    onChange(goal);
    ref.current?.focus();
  };

  return (
    <div>
      <div
        className={cx(
          "flex items-start gap-3 rounded-card border border-line bg-bg2 px-4 py-3.5 shadow-card",
          "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
          "focus-within:border-nav-accent/60"
        )}
      >
        <NavigatorGlyph size={18} className="mt-[3px] text-nav-accent" />
        <textarea
          ref={ref}
          rows={2}
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={keyDown}
          placeholder="Tell the Navigator what you want…"
          aria-label="Goal for the Navigator"
          className={cx(
            "min-w-0 flex-1 resize-none bg-transparent font-mono text-[13.5px] leading-6 text-ink outline-none",
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

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-ink-faint">Try</span>
        {EXAMPLE_GOALS.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => fill(g)}
            className={cx(
              "rounded-full border border-line bg-bg1 px-2.5 py-1 text-left text-[12px] text-ink-mute",
              "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
              "hover:border-nav-accent/40 hover:bg-nav-dim hover:text-ink"
            )}
          >
            {g}
          </button>
        ))}
      </div>
    </div>
  );
}
