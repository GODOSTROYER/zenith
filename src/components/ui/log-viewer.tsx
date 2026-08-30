"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "@/lib/format";
import { EmptyState } from "./empty-state";
import { SegmentedControl } from "./segmented-control";
import { Switch } from "./switch";

export interface LogLine {
  /** engine sequence number, when the line came from the event log */
  seq?: number;
  stream: "info" | "provider";
  line: string;
  /** ISO timestamp, rendered as a local time gutter when present */
  ts?: string;
}

type StreamFilter = "all" | "info" | "provider";

export interface LogViewerProps {
  lines: LogLine[];
  /** viewport height in px */
  height?: number;
  /** hard cap on rendered lines (oldest dropped) */
  maxLines?: number;
  emptyMessage?: string;
  className?: string;
}

const BADGE: Record<LogLine["stream"], string> = {
  info: "bg-info-dim text-info",
  provider: "bg-bg3 text-ink-faint",
};

const localTime = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
};

/**
 * Mono log tail. Auto-follow disengages the moment you scroll away and
 * re-engages when you return to the bottom. Renders at most `maxLines`.
 */
export function LogViewer({
  lines,
  height = 320,
  maxLines = 500,
  emptyMessage = "No output yet. Lines appear here as the deployment runs.",
  className,
}: LogViewerProps) {
  const [filter, setFilter] = useState<StreamFilter>("all");
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const pinning = useRef(false);

  const filtered = filter === "all" ? lines : lines.filter((l) => l.stream === filter);
  const shown = filtered.slice(-maxLines);
  const dropped = filtered.length - shown.length;

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !follow) return;
    pinning.current = true;
    el.scrollTop = el.scrollHeight;
  }, [shown.length, follow, filter]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onScroll = () => {
      if (pinning.current) {
        pinning.current = false;
        return;
      }
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      setFollow(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className={cx("overflow-hidden rounded-card border border-line bg-bg1", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <SegmentedControl<StreamFilter>
          size="sm"
          label="Log stream"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", title: "Every line" },
            { value: "info", label: "Orrery", title: "Orrery's own narration" },
            { value: "provider", label: "Provider", title: "Raw provider output" },
          ]}
        />
        <div className="flex items-center gap-2 text-[12px] text-ink-mute">
          <span>Follow</span>
          <Switch
            checked={follow}
            onChange={(v) => {
              setFollow(v);
              if (v && boxRef.current) {
                pinning.current = true;
                boxRef.current.scrollTop = boxRef.current.scrollHeight;
              }
            }}
            label="Follow new log lines"
          />
        </div>
      </div>

      <div ref={boxRef} style={{ height }} className="overflow-auto">
        {shown.length === 0 ? (
          <EmptyState title="Nothing logged yet" body={emptyMessage} />
        ) : (
          <div className="px-3 py-2 font-mono text-[12.5px] leading-[1.7]">
            {dropped > 0 && (
              <p className="pb-1 text-ink-faint">
                {dropped} earlier line{dropped === 1 ? "" : "s"} hidden — showing the last{" "}
                {maxLines}.
              </p>
            )}
            {shown.map((l, i) => (
              <div
                key={l.seq ?? `${i}-${l.line.slice(0, 12)}`}
                className="flex items-baseline gap-2.5 whitespace-pre-wrap"
              >
                {l.ts && (
                  <span className="tnum shrink-0 text-ink-faint" title={l.ts} suppressHydrationWarning>
                    {localTime(l.ts)}
                  </span>
                )}
                <span
                  className={cx(
                    "shrink-0 rounded-[4px] px-1 text-[10.5px] tracking-[0.04em] uppercase",
                    BADGE[l.stream]
                  )}
                >
                  {l.stream === "info" ? "orrery" : "provider"}
                </span>
                <span className="min-w-0 flex-1 break-words text-ink">{l.line}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
