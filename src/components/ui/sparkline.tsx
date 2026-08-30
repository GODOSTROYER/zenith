import { cx } from "@/lib/format";

export interface SparklineProps {
  points: number[];
  width?: number;
  height?: number;
  /** stroke colour class — defaults to the signal accent */
  className?: string;
  /** accessible description, e.g. "requests per minute, last hour" */
  label?: string;
}

/** Inline 80×24 trend line. Flat or single-point series render as a mid rule. */
export function Sparkline({
  points,
  width = 80,
  height = 24,
  className,
  label = "trend",
}: SparklineProps) {
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const vals = points.filter((n) => Number.isFinite(n));

  let d: string;
  if (vals.length === 0) {
    d = "";
  } else if (vals.length === 1) {
    d = `${pad},${pad + h / 2} ${pad + w},${pad + h / 2}`;
  } else {
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const flat = max === min;
    d = vals
      .map((v, i) => {
        const x = pad + (i / (vals.length - 1)) * w;
        const y = flat ? pad + h / 2 : pad + h - ((v - min) / span) * h;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={label}
      className={cx("shrink-0 overflow-visible text-signal", className)}
    >
      {d && (
        <polyline
          points={d}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
