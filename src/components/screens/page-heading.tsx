import type { ReactNode } from "react";

/** Consistent orientation for task screens; project and environment stay in chrome. */
export function PageHeading({ title, description, actions }: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 className="text-[24px] font-medium leading-tight tracking-[-0.015em] text-ink">{title}</h2>
        <p className="mt-2 max-w-[70ch] text-[14px] leading-relaxed text-ink-mute">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
