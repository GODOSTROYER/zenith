import { cx } from "@/lib/format";
import type { GimbalState } from "./gimbal-contract";

export { GIMBAL_STATE, type GimbalState } from "./gimbal-contract";

export interface NavigatorGlyphProps {
  size?: number;
  state?: GimbalState | null;
  className?: string;
  label?: string;
}

/** The compact, static core-and-notch mark. Full-body rendering lives in GimbalCharacter. */
export function NavigatorGlyph({ size = 20, state = null, className, label }: NavigatorGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none"
      role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}
      data-gimbal-state={state ?? "neutral"} className={cx("gimbal-mark shrink-0", className)}>
      <circle cx="16" cy="16" r="7.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M25.3 7.5C21.5 4.9 14.5 5.6 8.8 9.1C2.1 13.2-.2 19.6 3.8 23.1C7.7 26.6 16.3 25.2 23 21.1C28.9 17.4 31.3 12.1 29.1 8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="16" cy="16" r="4" fill="currentColor" opacity="0.2" />
      <path d="M13.5 14.7v2.6m5-2.6v2.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
