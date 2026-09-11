"use client";

import { useEffect, useState } from "react";
import { cx } from "@/lib/format";

import { ZENITH_SYMBOL_PATHS, ZENITH_LETTER_PATHS } from "./brand-geometry";

export interface OrbitMarkProps { size?: number; draw?: boolean; className?: string }

/** Export name remains compatible with product callers and celebration hooks. */
export function OrbitMark({ size = 18, draw = false, className }: OrbitMarkProps) {
  const [aligned, setAligned] = useState(!draw);
  useEffect(() => {
    if (!draw) return;
    const frame = requestAnimationFrame(() => setAligned(true));
    return () => cancelAnimationFrame(frame);
  }, [draw]);
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor" aria-hidden="true" className={cx("shrink-0", className)}>
      <path d={ZENITH_SYMBOL_PATHS[0]} style={{ transform: aligned ? "none" : "translateY(-3px)", transition: "transform 600ms var(--ease-swift)" }} />
      <path d={ZENITH_SYMBOL_PATHS[1]} style={{ transform: aligned ? "none" : "translateY(3px)", transition: "transform 600ms var(--ease-swift)" }} />
    </svg>
  );
}

export interface WordmarkProps { size?: number; draw?: boolean; className?: string }

export function Wordmark({ size = 18, draw = false, className }: WordmarkProps) {
  return (
    <span className={cx("zenith-wordmark inline-flex items-center gap-2", className)} role="img" aria-label="Zenith">
      <OrbitMark size={size} draw={draw} />
      <svg width={size * 3.65} height={size} viewBox="0 0 256 66" fill="currentColor" aria-hidden="true">
        {ZENITH_LETTER_PATHS.map((d) => <path key={d} d={d} fillRule="evenodd" />)}
      </svg>
    </span>
  );
}
