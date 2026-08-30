"use client";
import { useState } from "react";
import {
  Boxes,
  CalendarClock,
  Cpu,
  Globe,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Chip, Dialog } from "@/components/ui";
import { PlanFirst } from "@/components/inspector/plan-first";
import { cx } from "@/lib/format";

/** Blueprint catalog metadata, handed down from the server component. */
export interface BlueprintCard {
  id: string;
  name: string;
  description: string;
  icon: string;
  highlights: string[];
}

const ICONS: Record<string, LucideIcon> = {
  Boxes,
  Cpu,
  Globe,
  Sparkles,
  Wrench,
  CalendarClock,
};

export function BlueprintDialog({
  open,
  onClose,
  blueprints,
}: {
  open: boolean;
  onClose: () => void;
  blueprints: BlueprintCard[];
}) {
  const [picked, setPicked] = useState<string>("");

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={620}
      title="Start from a blueprint"
      description="An opinionated starting system. Everything in it is ordinary and editable afterwards."
    >
      <div className="space-y-2">
        {blueprints.map((b) => {
          const Icon = ICONS[b.icon] ?? Boxes;
          const active = picked === b.id;
          return (
            <button
              key={b.id}
              type="button"
              aria-pressed={active}
              onClick={() => setPicked(b.id)}
              className={cx(
                "flex w-full items-start gap-3 rounded-card border p-3 text-left",
                "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]",
                active
                  ? "border-signal bg-signal-dim"
                  : "border-line bg-bg1 hover:border-line-strong"
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-mute" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-ink">{b.name}</p>
                <p className="mt-0.5 text-[12.5px] text-ink-mute">{b.description}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {b.highlights.map((h) => (
                    <Chip key={h}>{h}</Chip>
                  ))}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <PlanFirst
          actionId="project.applyBlueprint"
          input={{ blueprint: picked }}
          label="Apply blueprint"
          disabled={!picked}
          disabledReason="Pick a blueprint first."
          onDone={onClose}
          onCancel={onClose}
        />
      </div>
    </Dialog>
  );
}

const SAMPLE = `services:
  web:
    image: ghcr.io/acme/web:1.0.0
    ports: ["3000:3000"]
  db:
    image: postgres:16`;

export function ImportComposeDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [yaml, setYaml] = useState("");

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={620}
      title="Import a docker-compose file"
      description="Paste the file. Everything Orrery cannot map is listed with a reason, never dropped silently."
    >
      <textarea
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        spellCheck={false}
        rows={14}
        placeholder={SAMPLE}
        aria-label="docker-compose.yml contents"
        className={cx(
          "w-full resize-y rounded-ctl border border-line bg-bg1 p-3 font-mono text-[12.5px] text-ink",
          "outline-none placeholder:text-ink-faint focus:border-signal",
          "transition-colors duration-[120ms] [transition-timing-function:var(--ease-swift)]"
        )}
      />
      <div className="mt-3 border-t border-line pt-3">
        <PlanFirst
          actionId="project.importCompose"
          input={{ composeYaml: yaml }}
          label="Preview import"
          disabled={!yaml.trim()}
          disabledReason="Paste a compose file first."
          onDone={onClose}
          onCancel={onClose}
        />
      </div>
    </Dialog>
  );
}
