import type { NavigatorRun } from "@/lib/domain/types";

export function ProviderChecks({ run }: { run: NavigatorRun }) {
  return <>
    {run.verificationNote && <p className="mt-3 text-[13px] text-ink-mute">{run.verificationNote}</p>}
    {run.verification?.checks && (
      <details className="mt-3 rounded-ctl border border-line px-3 py-2 text-[12px]">
        <summary className="cursor-pointer text-ink">Recorded provider checks</summary>
        <p className="mt-2 break-all font-mono text-ink-faint">{run.verification.evidenceRef}</p>
        <p className="text-ink-faint">Checked {new Date(run.verification.checkedAt).toLocaleString()}</p>
        <ul className="mt-2 space-y-2">
          {run.verification.checks.map((check, index) => (
            <li key={index}>
              <span className={check.passed ? "text-ink" : "text-err"}>{check.passed ? "Passed" : "Failed"}: {check.detail}</span>
              <span className="mt-0.5 block text-ink-faint">{check.provider} · revision {check.revisionId}</span>
            </li>
          ))}
        </ul>
      </details>
    )}
  </>;
}
