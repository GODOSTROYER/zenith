"use client";
import { useEffect, useState } from "react";
import { cx } from "@/lib/format";

/** Perimeter of the orbit path, generous enough to fully hide the stroke. */
const ORBIT_LEN = 44;

export interface OrbitMarkProps {
  size?: number;
  /** draw the orbit on mount (the once-per-project celebration) */
  draw?: boolean;
  className?: string;
}

/**
 * The Orrery mark: a body, its orbit, and one satellite on the path.
 * Drawn rather than borrowed — it is the only glyph that is not a lucide icon.
 */
export function OrbitMark({ size = 18, draw = false, className }: OrbitMarkProps) {
  const [hidden, setHidden] = useState(draw);

  useEffect(() => {
    if (!draw) return;
    const t = requestAnimationFrame(() => setHidden(false));
    return () => cancelAnimationFrame(t);
  }, [draw]);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={cx("shrink-0", className)}
    >
      <ellipse
        cx="10"
        cy="10"
        rx="8.2"
        ry="4.4"
        transform="rotate(-28 10 10)"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.55"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeDasharray={ORBIT_LEN}
        strokeDashoffset={hidden ? ORBIT_LEN : 0}
        style={{ transition: "stroke-dashoffset 600ms var(--ease-swift)" }}
      />
      <circle cx="10" cy="10" r="2.7" fill="currentColor" />
      <circle
        cx="17.2"
        cy="6.2"
        r="1.6"
        fill="currentColor"
        style={{
          opacity: hidden ? 0 : 1,
          transition: "opacity 200ms var(--ease-swift) 480ms",
        }}
      />
    </svg>
  );
}

export interface WordmarkProps {
  size?: number;
  draw?: boolean;
  className?: string;
}

/** Mark + name, the app's one piece of branding. */
export function Wordmark({ size = 18, draw = false, className }: WordmarkProps) {
  return (
    <span className={cx("inline-flex items-center gap-2 text-ink", className)}>
      <OrbitMark size={size} draw={draw} className="text-signal" />
      <span
        className="font-medium tracking-[0.01em]"
        style={{ fontSize: Math.round(size * 0.85) }}
      >
        Orrery
      </span>
    </span>
  );
}
