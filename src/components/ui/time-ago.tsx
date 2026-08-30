"use client";
import { useEffect, useState } from "react";
import { cx, fmtDate, timeAgo } from "@/lib/format";

export interface TimeAgoProps {
  /** ISO 8601 timestamp */
  iso: string;
  /** prefix, e.g. "deployed" → "deployed 4m ago" */
  prefix?: string;
  className?: string;
}

/** Relative time that refreshes every 30s; the exact local time is the tooltip. */
export function TimeAgo({ iso, prefix, className }: TimeAgoProps) {
  const [text, setText] = useState(() => timeAgo(iso));

  useEffect(() => {
    setText(timeAgo(iso));
    const t = setInterval(() => setText(timeAgo(iso)), 30_000);
    return () => clearInterval(t);
  }, [iso]);

  return (
    <time
      dateTime={iso}
      title={fmtDate(iso)}
      suppressHydrationWarning
      className={cx("whitespace-nowrap", className)}
    >
      {prefix ? `${prefix} ${text}` : text}
    </time>
  );
}
