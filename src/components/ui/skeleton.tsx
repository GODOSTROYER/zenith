import { cx } from "@/lib/format";
import styles from "./skeleton.module.css";

export interface SkeletonProps {
  className?: string;
  /** CSS width, e.g. "12rem" or "60%" */
  width?: string | number;
  height?: string | number;
  /** pill shape for avatars/dots */
  round?: boolean;
}

/** A quiet, theme-aware placeholder. Motion is decorative and entirely optional. */
export function Skeleton({ className, width, height, round = false }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      data-skeleton=""
      style={{ width, height }}
      className={cx(
        styles.placeholder,
        round ? "rounded-full" : "rounded-ctl",
        height === undefined && "h-4",
        className
      )}
    />
  );
}
