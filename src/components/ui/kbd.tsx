import type { ReactNode } from "react";
import { cx } from "@/lib/format";

/** A keyboard key cap. Use one per key: `<Kbd>⌘</Kbd><Kbd>K</Kbd>`. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line bg-bg3 px-1.5",
        "font-mono text-[11px] leading-none text-ink-mute",
        className
      )}
    >
      {children}
    </kbd>
  );
}
