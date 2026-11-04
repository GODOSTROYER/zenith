/** Release pipelines: one row per image digest moving through one service. Read-only list. */
import Link from "next/link";
import { platformReleaseSafety } from "@/lib/platform/release-safety";
import { loadPage } from "../_lib/loaders";
import { EvidenceNote, PageState } from "../_components/page-state";

export const dynamic = "force-dynamic";

export default async function ReleasesPage() {
  const result = await loadPage(async (context) => {
    const svc = await platformReleaseSafety();
    return svc ? svc.list(context.workspaceId, { limit: 100 }) : null;
  });
  if ("error" in result) return <PageState {...result} />;
  const releases = result.data;
  return (
    <div className="space-y-5">
      <h1 className="app-page-title">Releases</h1>
      <EvidenceNote />
      <p className="text-[13px] text-ink-mute">
        Each release binds one image digest to one service. A data or contract migration needs a separate approval from a person other than the requester: approve it on the release page, then deploy again.
      </p>
      {releases === null ? (
        <PageState error="The platform store is not configured, so release records are unavailable." />
      ) : releases.length === 0 ? (
        <p className="text-[13px] text-ink-mute">No releases recorded yet. They appear when a deployment rolls out a service.</p>
      ) : (
        <table className="w-full text-left text-[13px]">
          <caption className="sr-only">Release pipelines, newest first</caption>
          <thead>
            <tr className="border-b border-line text-ink-mute">
              <th scope="col" className="py-2 pr-4">Service</th>
              <th scope="col" className="pr-4">Kind</th>
              <th scope="col" className="pr-4">State</th>
              <th scope="col" className="pr-4">Digest</th>
              <th scope="col" className="pr-4">Migration</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {releases.map((r) => (
              <tr key={r.id} className="border-b border-line">
                <td className="py-2 pr-4"><Link className="text-signal underline" href={`/platform/releases/${encodeURIComponent(r.id)}`}>{r.serviceAddress}</Link></td>
                <td className="pr-4">{r.kind === "rollback" ? "Code rollback" : "Release"}</td>
                <td className="pr-4">{r.state.replaceAll("_", " ")}</td>
                <td className="pr-4 font-mono">{r.imageDigest.slice(0, 19)}</td>
                <td className="pr-4">{r.migration.class === "none" ? "None" : `${r.migration.class} (${r.migration.status.replaceAll("_", " ")})`}</td>
                <td>{new Date(r.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
