import { cx } from "@/lib/format";

export interface SkeletonProps {
  className?: string;
  /** CSS width, e.g. "12rem" or "60%" */
  width?: string | number;
  height?: string | number;
  /** pill shape for avatars/dots */
  round?: boolean;
}

/** Loading placeholder. Subtle opacity pulse, no shimmer sweep. */
export function Skeleton({ className, width, height, round = false }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      style={{ width, height }}
      className={cx(
        "status-pulse block bg-bg3",
        round ? "rounded-full" : "rounded-ctl",
        !height && "h-4",
        className
      )}
    />
  );
}
