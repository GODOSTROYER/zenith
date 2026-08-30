import { cx } from "@/lib/format";

export interface NavigatorGlyphProps {
  size?: number;
  className?: string;
}

/**
 * The Navigator's mark: an orbital compass — a needle inside a tilted orbit,
 * with one body on the ring. Drawn in currentColor so it always carries
 * nav-accent and nothing else in the product ever uses it.
 */
export function NavigatorGlyph({ size = 20, className }: NavigatorGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={cx("shrink-0", className)}
    >
      <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.2" />
      <ellipse
        cx="12"
        cy="12"
        rx="9.25"
        ry="4"
        stroke="currentColor"
        strokeOpacity="0.45"
        strokeWidth="1.2"
        transform="rotate(-28 12 12)"
      />
      <path
        d="M15.6 8.4 10.9 10.6 8.4 15.6 13.1 13.4Z"
        fill="currentColor"
        fillOpacity="0.9"
      />
      <circle cx="19.2" cy="8.1" r="1.6" fill="currentColor" />
    </svg>
  );
}
