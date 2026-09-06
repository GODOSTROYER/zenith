"use client";
import { useEffect, useState } from "react";
import { cx } from "@/lib/format";

/** Dome length. The OrbitMark export stays compatible with existing callers. */
const ORBIT_LEN = 26;

export interface OrbitMarkProps {
  size?: number;
  /** draw the orbit on mount (the once-per-project celebration) */
  draw?: boolean;
  className?: string;
}

/**
 * Zenith.ai: an observer, a sightline, and the point directly overhead.
 * The stable corporate mark is distinct from Gimbal's moving rings.
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
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cx("shrink-0", className)}
    >
      <path
        d="M4 17a8 8 0 0 1 16 0"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.55"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={ORBIT_LEN}
        strokeDashoffset={hidden ? ORBIT_LEN : 0}
        style={{ transition: "stroke-dashoffset 600ms var(--ease-swift)" }}
      />
      <path d="M12 10v7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="19.5" r="1.3" fill="currentColor" />
      <circle
        cx="12"
        cy="4.5"
        r="2"
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
        className="font-semibold tracking-[-0.02em]"
        style={{ fontSize: Math.round(size * 0.85) }}
      >
        Zenith<span className="font-normal">.ai</span>
      </span>
    </span>
  );
}
