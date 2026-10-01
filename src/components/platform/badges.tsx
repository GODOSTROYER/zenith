/**
 * Small presenters shared by the platform components: a risk label that also
 * covers `critical`, a native disclosure, the scope breadcrumb and a digest with
 * a copy button. Tokens only; no component here knows about a route.
 */
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { Scope } from "@/lib/controlplane/types";
import { cx } from "@/lib/format";
import { CopyButton } from "@/components/ui/copy-button";
import { RiskBadge } from "@/components/ui/risk-badge";
import { shortDigest } from "./text";

export type PlatformRisk = "low" | "medium" | "high" | "critical";

/** The kit's RiskBadge knows low/medium/high; capability risk adds `critical`. */
export function RiskLabel({ level, className }: { level: PlatformRisk; className?: string }) {
  if (level !== "critical") return <RiskBadge level={level} className={className} />;
  return (
    <span
      title="Critical risk — can destroy data or access, or bypass normal safeguards. Review every detail."
      className={cx(
        "inline-flex items-center rounded-[2px] border border-err/40 bg-err-dim px-2 py-0.5",
        "text-[11px] font-semibold tracking-[0.03em] text-err uppercase",
        className
      )}
    >
      critical
    </span>
  );
}

/** A native `<details>` styled as a quiet disclosure. Keyboard and AT support come for free. */
export function Disclosure({
  summary,
  children,
  className,
  open,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
}) {
  return (
    <details open={open} className={cx("group/disclosure text-[12.5px]", className)}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-ink-mute hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="h-3.5 w-3.5 transition-transform duration-[var(--dur-fast)] group-open/disclosure:rotate-90"
          aria-hidden="true"
        />
        {summary}
      </summary>
      <div className="mt-2 pl-[18px]">{children}</div>
    </details>
  );
}

export interface ScopeNames {
  workspace?: string;
  project?: string;
  environment?: string;
  resource?: string;
}

/**
 * workspace › project › environment › resource. A display name is used when the
 * host knows one; otherwise the id is shown, in monospace, so it reads as an id.
 */
export function ScopeBreadcrumb({ scope, names }: { scope: Scope; names?: ScopeNames }) {
  const parts: { key: string; label: string; isId: boolean }[] = [];
  const push = (key: keyof ScopeNames, id: string | undefined) => {
    if (!id) return;
    const name = names?.[key];
    parts.push({ key, label: name ?? id, isId: !name });
  };
  push("workspace", scope.workspaceId);
  push("project", scope.projectId);
  push("environment", scope.environmentId);
  push("resource", scope.resourceId);
  return (
    <nav aria-label="Scope">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[12.5px] text-ink-mute">
        {parts.map((p, i) => (
          <li key={p.key} className="flex items-center gap-1" aria-current={i === parts.length - 1 ? "location" : undefined}>
            {i > 0 && <ChevronRight className="h-3 w-3 text-ink-faint" aria-hidden="true" />}
            <span className={cx(p.isId && "font-mono text-[12px]", i === parts.length - 1 && "text-ink")}>{p.label}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** A digest as a short monospace prefix plus a button that copies the whole thing. */
export function DigestValue({ digest, what }: { digest: string; what: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <code className="tnum font-mono text-[12.5px] text-ink" title={digest}>
        {shortDigest(digest)}…
      </code>
      <CopyButton value={digest} what={what} />
    </span>
  );
}

/** A labelled fact: `<dt>` muted, `<dd>` ink. */
export function Fact({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <dt className="text-[12px] text-ink-mute">{label}</dt>
      <dd className="mt-0.5 text-[13px] text-ink">{children}</dd>
    </div>
  );
}
