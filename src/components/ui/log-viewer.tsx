"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Download, Search } from "lucide-react";
import { cx } from "@/lib/format";
import { Button } from "./button";
import { EmptyState } from "./empty-state";
import { Input } from "./input";
import { SegmentedControl } from "./segmented-control";
import { Select } from "./select";
import { Switch } from "./switch";

export interface LogLine {
  /** engine sequence number, when the line came from the event log */
  seq?: number;
  /**
   * Which lane the line came out of. `info`/`provider` are Zenith's own
   * narration vs. raw provider output during a deployment; `stdout`/`stderr`
   * are what a running service actually wrote.
   */
  stream: "info" | "provider" | "stdout" | "stderr";
  line: string;
  /** ISO timestamp, rendered as a local time gutter when present */
  ts?: string;
}

export interface LogViewerProps {
  lines: LogLine[];
  /** viewport height in px */
  height?: number;
  /** hard cap on rendered lines (oldest dropped) */
  maxLines?: number;
  emptyMessage?: string;
  /** accessible name for the log region, e.g. "api logs" */
  label?: string;
  /** filename for the download button; omit to hide the button */
  downloadName?: string;
  className?: string;
}

interface StreamMeta {
  label: string;
  badge: string;
  title: string;
}

const STREAMS: Record<LogLine["stream"], StreamMeta> = {
  info: { label: "Zenith", badge: "bg-info-dim text-info", title: "Zenith's own narration" },
  provider: { label: "provider", badge: "bg-bg3 text-ink-faint", title: "Raw provider output" },
  stdout: { label: "stdout", badge: "bg-bg3 text-ink-faint", title: "The service's standard output" },
  stderr: { label: "stderr", badge: "bg-err-dim text-err", title: "The service's error output" },
};

const STREAM_ORDER = Object.keys(STREAMS) as LogLine["stream"][];

/** Levels the log formats in this product actually emit, worst first. */
const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG"] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_RE = /\b(FATAL|ERROR|WARNING|WARN|INFO|DEBUG|TRACE)\b/;

function levelOf(line: string): Level | undefined {
  const m = LEVEL_RE.exec(line);
  if (!m) return undefined;
  const raw = m[1];
  if (raw === "FATAL") return "ERROR";
  if (raw === "WARNING") return "WARN";
  if (raw === "TRACE") return "DEBUG";
  return raw as Level;
}

/**
 * Split a line around every case-insensitive occurrence of `needle`, so the
 * search can mark what it matched instead of leaving the reader to find it.
 * Exported for its test; the empty needle returns the line untouched.
 */
export function splitMatches(line: string, needle: string): { text: string; hit: boolean }[] {
  if (!needle) return [{ text: line, hit: false }];
  const hay = line.toLowerCase();
  const find = needle.toLowerCase();
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (let i = hay.indexOf(find); i !== -1; i = hay.indexOf(find, at)) {
    if (i > at) out.push({ text: line.slice(at, i), hit: false });
    out.push({ text: line.slice(i, i + needle.length), hit: true });
    at = i + needle.length;
  }
  if (at < line.length) out.push({ text: line.slice(at), hit: false });
  return out;
}

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
 *
 * The stream and level filters are built from the lines actually present, so
 * the control is never offered where it would do nothing.
 */
export function LogViewer({
  lines,
  height = 320,
  maxLines = 500,
  emptyMessage = "No output yet. Lines appear here as the deployment runs.",
  label = "Log output",
  downloadName,
  className,
}: LogViewerProps) {
  const [stream, setStream] = useState<"all" | LogLine["stream"]>("all");
  const [level, setLevel] = useState<"all" | Level>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  const streamsPresent = useMemo(
    () => STREAM_ORDER.filter((s) => lines.some((l) => l.stream === s)),
    [lines]
  );
  const levelsPresent = useMemo(
    () => LEVELS.filter((lv) => lines.some((l) => levelOf(l.line) === lv)),
    [lines]
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return lines.filter(
      (l) =>
        (stream === "all" || l.stream === stream) &&
        (level === "all" || levelOf(l.line) === level) &&
        (!needle || l.line.toLowerCase().includes(needle))
    );
  }, [lines, stream, level, query]);

  const shown = filtered.slice(-maxLines);
  const dropped = filtered.length - shown.length;
  const narrowed = filtered.length !== lines.length;

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !follow) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered, maxLines, follow, wrap]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      setFollow(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  /** Saves exactly what is on screen — no round trip, nothing the viewer never had. */
  const download = () => {
    const text = shown.map((l) => `${l.ts ? `${l.ts} ` : ""}${l.stream} ${l.line}`).join("\n");
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName ?? "logs.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={cx("overflow-hidden rounded-card border border-line bg-bg1", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        {streamsPresent.length > 1 && (
          <SegmentedControl<"all" | LogLine["stream"]>
            size="sm"
            label="Log stream"
            value={stream}
            onChange={setStream}
            options={[
              { value: "all", label: "All", title: "Every line" },
              ...streamsPresent.map((s) => ({
                value: s,
                label: STREAMS[s].label,
                title: STREAMS[s].title,
              })),
            ]}
          />
        )}

        {levelsPresent.length > 1 && (
          <Select
            className="w-[124px]"
            aria-label="Log level"
            value={level}
            onChange={(e) => setLevel(e.target.value as "all" | Level)}
            options={[
              { value: "all", label: "All levels" },
              ...levelsPresent.map((lv) => ({ value: lv, label: lv })),
            ]}
          />
        )}

        <Input
          className="w-[180px]"
          aria-label="Search these log lines"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          prefix={<Search className="h-3.5 w-3.5" />}
        />

        <span className="tnum text-[12px] text-ink-faint">
          {narrowed ? `${filtered.length} of ${lines.length}` : `${lines.length}`} line
          {lines.length === 1 && !narrowed ? "" : "s"}
        </span>

        <div className="ml-auto flex items-center gap-2 text-[12px] text-ink-mute">
          {downloadName && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Download className="h-3.5 w-3.5" />}
              disabled={shown.length === 0}
              disabledReason="There is nothing loaded to save yet."
              title={`Save the ${shown.length} line${shown.length === 1 ? "" : "s"} shown as ${downloadName}`}
              onClick={download}
            >
              Download
            </Button>
          )}
          <span>Wrap</span>
          <Switch
            checked={wrap}
            onChange={setWrap}
            label="Wrap long log lines instead of scrolling sideways"
          />
          <span>Follow</span>
          <Switch
            checked={follow}
            onChange={(v) => {
              setFollow(v);
              if (v && boxRef.current) {
                boxRef.current.scrollTop = boxRef.current.scrollHeight;
              }
            }}
            label="Follow new log lines"
          />
        </div>
      </div>

      {/*
       * role="log" + aria-relevant="additions" announces new lines only, never
       * the whole buffer, and never the old lines dropped off the top.
       * ponytail: politeness is tied to Follow — turning Follow off silences the
       * region, which is the same gesture that stops the visual firehose. A
       * per-line rate limiter would need a buffer; add one if a provider ever
       * bursts thousands of lines at once.
       */}
      <div
        ref={boxRef}
        style={{ height }}
        role="log"
        aria-label={label}
        aria-live={follow ? "polite" : "off"}
        aria-relevant="additions"
        aria-atomic="false"
        tabIndex={0}
        className="overflow-auto focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-signal"
      >
        {shown.length === 0 ? (
          <EmptyState
            title={narrowed ? "No line matches these filters" : "Nothing logged yet"}
            body={
              narrowed
                ? `${lines.length} line${lines.length === 1 ? " is" : "s are"} loaded, but none match the search or filters. Clear them to see everything.`
                : emptyMessage
            }
          />
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
                key={l.seq ?? `${dropped + i}-${l.ts ?? ""}-${l.line.slice(0, 12)}`}
                className={cx(
                  "flex items-baseline gap-2.5",
                  wrap ? "whitespace-pre-wrap" : "w-max whitespace-pre"
                )}
              >
                {l.ts && (
                  <span className="tnum shrink-0 text-ink-faint" title={l.ts} suppressHydrationWarning>
                    {localTime(l.ts)}
                  </span>
                )}
                <span
                  className={cx(
                    "shrink-0 rounded-[2px] px-1 text-[10.5px] tracking-[0.04em] uppercase",
                    STREAMS[l.stream].badge
                  )}
                >
                  {STREAMS[l.stream].label}
                </span>
                <span className={cx("min-w-0 flex-1 text-ink", wrap && "break-words")}>
                  {splitMatches(l.line, query.trim()).map((part, p) =>
                    part.hit ? (
                      <mark key={p} className="rounded-[2px] bg-signal/25 text-ink">
                        {part.text}
                      </mark>
                    ) : (
                      <span key={p}>{part.text}</span>
                    )
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
