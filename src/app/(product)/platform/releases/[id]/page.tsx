/** One release: stages, bound digest and provenance, migration review, rollout, readback and rollback safety. */
import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { platformReleaseSafety } from "@/lib/platform/release-safety";
import { notFound } from "@/lib/capabilities/errors";
import { RELEASE_STATES, requiresHumanApproval } from "@/lib/release-safety";
import { loadPage } from "../../_lib/loaders";
import { EvidenceNote, PageState } from "../../_components/page-state";
import { ReleaseActions } from "./release-actions";

export const dynamic = "force-dynamic";

const STAGES = ["planned", "built", "verified", "deployed", "migrated", "ready", "cut_over", "readback_verified"] as const;
const label = (s: string) => s.replaceAll("_", " ");

export default async function ReleasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadPage(async (context) => {
    const svc = await platformReleaseSafety();
    if (!svc) throw notFound();
    const release = await svc.get(context.workspaceId, id).catch(() => null);
    if (!release) throw notFound();
    const [events, rollback] = await Promise.all([
      svc.events(context.workspaceId, release.id),
      svc.rollbackSafety({ workspaceId: release.workspaceId, environmentId: release.environmentId, serviceAddress: release.serviceAddress, targetDigest: release.imageDigest }),
    ]);
    return { release, events, rollback };
  });
  if ("error" in result) return <PageState {...result} />;
  const { release: r, events, rollback } = result.data;
  const { context } = result;
  const reached = new Set(events.map((e) => e.to));
  const m = r.migration;
  const needsApproval = requiresHumanApproval(m.class);
  const isRequester = r.requestedBy === context.principal.id;
  const canApprove = r.state === "blocked_approval" && needsApproval && !isRequester && context.role === "admin";
  const approveReason = r.state !== "blocked_approval" ? "This release is not waiting for a migration approval." : isRequester ? "The person who requested this release cannot approve its migration." : context.role !== "admin" ? "Only a workspace admin can approve a migration." : undefined;
  return (
    <div className="space-y-5">
      <p className="text-[13px]"><Link className="text-signal underline" href="/platform/releases">All releases</Link></p>
      <h1 className="app-page-title">Release of {r.serviceAddress}</h1>
      <EvidenceNote />

      <section aria-labelledby="stages" className="space-y-2">
        <h2 id="stages" className="text-[15px] font-medium">Stages</h2>
        <ol className="flex flex-wrap gap-2 text-[12px]">
          {STAGES.map((s) => (
            <li key={s} aria-current={r.state === s ? "step" : undefined} className={`rounded border px-2 py-1 ${r.state === s ? "border-signal text-signal" : reached.has(s) ? "border-line text-ink" : "border-line text-ink-mute"}`}>
              {label(s)}{reached.has(s) ? " (reached)" : ""}
            </li>
          ))}
        </ol>
        <p className="text-[13px]">Current state: <strong>{label(r.state)}</strong>{r.reason ? `. ${r.reason}` : ""}</p>
        {!RELEASE_STATES.includes(r.state) && <Callout tone="err">Unknown state.</Callout>}
        {r.state === "cut_over_unverified" && <Callout tone="info">Traffic was cut over but this provider adapter cannot read back what is serving, so the digest is not verified by readback.</Callout>}
      </section>

      <section aria-labelledby="digest" className="space-y-1 text-[13px]">
        <h2 id="digest" className="text-[15px] font-medium">Bound digest and provenance</h2>
        <p>Image digest: <code>{r.imageDigest}</code> (immutable for this release)</p>
        <p>Image: <code>{r.imageUri}</code></p>
        {r.sourceDigest && <p>Source digest: <code>{r.sourceDigest}</code></p>}
        <p>Provenance: <strong>{r.provenance.level === "none" ? "not verified" : label(r.provenance.level)}</strong>{r.provenance.evidenceRef ? ` (${r.provenance.evidenceRef})` : ""}</p>
        {r.previousDigest && <p>Replaces digest: <code>{r.previousDigest}</code></p>}
        <p>Requested by: {r.requestedBy}</p>
      </section>

      <section aria-labelledby="migration" className="space-y-2 text-[13px]">
        <h2 id="migration" className="text-[15px] font-medium">Migration</h2>
        <p>Class: <strong>{m.class}</strong>. Status: {label(m.status)}{m.exitCode !== undefined ? `, exit code ${m.exitCode}` : ""}.</p>
        {m.class === "none" ? <p>This release has no migration.</p> : (
          <>
            {m.findings.length > 0 ? (
              <ul className="list-disc pl-5">{m.findings.map((f) => <li key={f}>{f}</li>)}</ul>
            ) : <p>No SQL was supplied for classification; the class is the one declared in the manifest.</p>}
            <p className="text-ink-mute">Zenith stores the digest of the command{m.sqlDigest ? " and of the SQL" : ""}, never the text. {m.commandDigest && <>Command digest <code>{m.commandDigest.slice(0, 16)}</code>. </>}Review the migration source in your repository against these digests.</p>
            {m.bindingDigest && <p>Approval binds: environment, service, image digest, command digest, class. Binding <code>{m.bindingDigest}</code>.</p>}
          </>
        )}
        {needsApproval && (
          <Callout tone="info" title="Approve, then deploy again">
            A {m.class} migration needs a separate approval from a person other than the requester. Approving does not deploy anything: after you approve, deploy again and the migration runs once. The approval is single use, expires, and covers only this exact digest and command.
          </Callout>
        )}
        {needsApproval && m.bindingDigest && (
          <ReleaseActions releaseId={r.id} bindingDigest={m.bindingDigest} workspaceId={context.workspaceId} disabledReason={canApprove ? undefined : approveReason} migrationClass={m.class} />
        )}
      </section>

      <section aria-labelledby="rollout" className="space-y-1 text-[13px]">
        <h2 id="rollout" className="text-[15px] font-medium">Rollout and readback</h2>
        <p>Strategy: {r.rollout.strategy}{r.rollout.strategy === "progressive" ? `, steps ${r.rollout.steps.join("%, ")}%, bake ${r.rollout.bakeSec}s` : ""}. Serving the candidate: {r.rollout.percent}%.</p>
        <p>Readback: {r.readback ? `${r.readback.status}${r.readback.observedDigest ? ` (${r.readback.observedDigest})` : ""}${r.readback.detail ? `. ${r.readback.detail}` : ""}` : "not recorded yet"}</p>
      </section>

      <section aria-labelledby="rollback" className="space-y-1 text-[13px]">
        <h2 id="rollback" className="text-[15px] font-medium">Code rollback to this digest</h2>
        {rollback.allowed ? <p>A code rollback to this digest is allowed. It restores code only and never reverts data.</p> : <Callout tone="err" title="Code rollback refused">{rollback.reason}</Callout>}
        {rollback.warnings.map((w) => <p key={w}>{w}</p>)}
      </section>

      <section aria-labelledby="history" className="space-y-1 text-[13px]">
        <h2 id="history" className="text-[15px] font-medium">History</h2>
        <ol className="list-decimal pl-5">{events.map((e) => <li key={e.seq}>{label(e.to)}: {e.detail} <span className="text-ink-mute">({new Date(e.at).toLocaleString()})</span></li>)}</ol>
      </section>
    </div>
  );
}
