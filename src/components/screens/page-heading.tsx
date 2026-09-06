import type { ReactNode } from "react";

/** Consistent orientation for task screens; project and environment stay in chrome. */
export function PageHeading({ title, description, actions }: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="app-page-heading">
      <div className="min-w-0">
        <h2 className="app-page-title">{title}</h2>
        {description && <p className="mt-2 max-w-[70ch] text-[14px] leading-relaxed text-ink-mute">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
