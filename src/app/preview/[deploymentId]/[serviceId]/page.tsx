import Link from "next/link";
import type { Metadata } from "next";
import { q } from "@/lib/db/store";
import { env } from "@/lib/env";
import type {
  Deployment,
  Environment,
  Manifest,
  Project,
  Revision,
} from "@/lib/domain/types";
import { Wordmark } from "@/components/shell/wordmark";
import { ThemeToggle } from "@/components/ui/theme-toggle";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Simulated preview" };

/** The four rows this page renders, and nothing else. */
interface PreviewRead {
  deployment?: Deployment;
  revision?: Revision;
  project?: Project;
  environment?: Environment;
  manifest?: Manifest;
}

/**
 * The one deployment this address names.
 *
 * This route is a **public path** (`isPublicPath`, src/lib/supabase/env.ts):
 * there is no signed-in caller to scope a snapshot to, and there is no client
 * payload to reuse either — `GET /api/deployments/:id` resolves through
 * `scopedDeployment`, which requires a membership this reader may not have. So
 * on Postgres the page does the opposite of taking a snapshot: it asks for the
 * four rows it needs, **by id**, through a read that cannot widen to a tenant
 * slice or an install-wide graph. On the file store `q.*` already is that read.
 *
 * `env()` rather than `isPostgres()` on purpose: the branch must be decidable
 * without pulling the Postgres stack into a file-mode render, and the dynamic
 * import below is what keeps `@supabase/supabase-js` out of this bundle.
 */
async function readPreview(deploymentId: string): Promise<PreviewRead> {
  if (env().ZENITH_STORE !== "postgres") {
    const deployment = q.deployment(deploymentId);
    if (!deployment) return {};
    const revision = q.revision(deployment.revisionId);
    return {
      deployment,
      revision,
      manifest: revision?.manifest,
      project: q.project(deployment.projectId),
      environment: q.environment(deployment.environmentId),
    };
  }
  const [{ readRowsByIdAsync }, { revisionManifestAsync }] = await Promise.all([
    import("@/lib/db/postgres-store"),
    import("@/lib/db/store"),
  ]);
  const [deployment] = await readRowsByIdAsync<Deployment>("deployments", [deploymentId]);
  if (!deployment) return {};
  const [revisions, projects, environments] = await Promise.all([
    readRowsByIdAsync<Revision>("revisions", [deployment.revisionId]),
    readRowsByIdAsync<Project>("projects", [deployment.projectId]),
    readRowsByIdAsync<Environment>("environments", [deployment.environmentId]),
  ]);
  // Awaited, not `revision.manifest`: that accessor is a synchronous getter,
  // and on Postgres a synchronous getter can only be served by parking the
  // request thread on the blocking bridge.
  const manifest = revisions[0] ? await revisionManifestAsync(revisions[0].id) : undefined;
  return {
    deployment,
    revision: revisions[0],
    manifest,
    project: projects[0],
    environment: environments[0],
  };
}

/** Use the provider's recorded label without inventing a published hostname. */
function prettyHost(label: string): string {
  const at = label.indexOf(" — ");
  return at < 0 ? label : label.slice(at + 3);
}

function Missing({ title, fix }: { title: string; fix: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg0 p-8">
      <div className="max-w-[520px] space-y-4 border-y border-line py-8">
        <Wordmark size={22} />
        <h1 className="app-page-title">{title}</h1>
        <p className="text-[14px] leading-relaxed text-ink-mute">{fix}</p>
        <p className="pt-2">
          <Link href="/overview" className="text-[13px] text-signal hover:underline">
            Back to Zenith
          </Link>
        </p>
      </div>
    </main>
  );
}

export default async function PreviewPage({
  params,
}: {
  params: Promise<{ deploymentId: string; serviceId: string }>;
}) {
  const { deploymentId, serviceId } = await params;

  const { deployment, revision, manifest, project, environment } = await readPreview(deploymentId);
  if (!deployment)
    return (
      <Missing
        title="No such deployment"
        fix="This preview address belongs to a deployment that no longer exists. Open the project's Deploys tab to find a current one."
      />
    );

  const service = manifest?.services.find((s) => s.id === serviceId);

  if (!service || !project)
    return (
      <Missing
        title="That service is not part of this deployment"
        fix="The address may be from an older revision. Open the deployment in Zenith to see what it actually published."
      />
    );

  if (deployment.status !== "succeeded")
    return (
      <Missing
        title="Preview unavailable"
        fix={`This deployment is ${deployment.status.replaceAll("_", " ")}. A simulated preview is available only after a successful deployment. Open the project's Deploys tab to check its progress or outcome.`}
      />
    );

  const output = deployment.outputs.find(
    (o) =>
      o.targetId === serviceId &&
      o.kind === "url" &&
      o.value === `/preview/${deploymentId}/${serviceId}`
  );
  if (!output)
    return (
      <Missing
        title="No preview was published for this service"
        fix="This deployment did not record a simulated preview address for this service. Open the project's Deploys tab to see its available outputs."
      />
    );

  const host = prettyHost(output.label);

  return (
    <div className="min-h-dvh bg-bg0">
      <header className="mx-auto flex max-w-[1000px] items-center justify-between px-6 py-5"><Link href="/overview"><Wordmark size={22} /></Link><ThemeToggle /></header>
      <div className="border-b border-warn/25 bg-warn-dim">
        <div className="mx-auto flex max-w-[1000px] flex-wrap items-center justify-between gap-3 px-6 py-3">
          <p className="text-[12.5px] text-ink">
            <strong className="font-medium">Simulated preview</strong> — recorded output:{" "}
            <span className="break-all font-mono">{host}</span>. Nothing real is being served.
          </p>
          <Link
            href={`/p/${project.slug}`}
            className="text-[12.5px] font-medium text-ink hover:underline"
          >
            Back to {project.name}
          </Link>
        </div>
      </div>

      <main className="mx-auto max-w-[1000px] px-6 py-12 sm:py-16">
        <div>
          <h1 className="app-page-title break-words">
            {service.name} · simulated preview
          </h1>
          <p className="mt-3 break-words text-[13px] text-ink-mute">{project.name} · {environment?.name ?? "environment"}{environment?.class === "production" &&<span className="ml-2 rounded-[var(--r-pill)] bg-warn-dim px-2 py-1 text-prod">Production</span>}</p>
          <p className="mt-6 max-w-[65ch] text-[14px] leading-relaxed text-ink-mute">
            This deployment completed successfully and recorded a preview for{" "}
            <span className="font-mono text-ink">{service.name}</span>. No real application is
            served here, and this page does not check live service health.
          </p>

          <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-6 border-y border-line bg-bg2 px-5 py-6 text-left sm:grid-cols-4">
            {[
              ["Revision", revision ? `r${revision.number}` : "—"],
              ["Kind", service.kind],
              ["Size", `${service.size} × ${service.replicas}`],
              ["Health path", service.healthPath ?? "—"],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-[12px] text-ink-faint">{k}</dt>
                <dd className="tnum mt-2 break-all font-mono text-[13px] text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-7 flex flex-wrap gap-4 text-[13px]"><Link href={`/p/${project.slug}/deploys?env=${encodeURIComponent(deployment.environmentId)}&deployment=${encodeURIComponent(deployment.id)}`} className="inline-flex min-h-9 items-center rounded-ctl bg-signal px-4 font-medium text-on-signal transition-colors hover:bg-signal-strong">Inspect deployment</Link><Link href={`/p/${project.slug}?env=${encodeURIComponent(deployment.environmentId)}`} className="inline-flex min-h-9 items-center text-ink-mute hover:text-ink">Open system</Link></div>
        </div>
      </main>
    </div>
  );
}
