import Link from "next/link";
import type { Metadata } from "next";
import { q } from "@/lib/db/store";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Simulated preview" };

/** `web — https://web--staging.atlas.orrery.app` → the address half. */
function prettyHost(label: string | undefined, fallback: string): string {
  if (!label) return fallback;
  const at = label.indexOf(" — ");
  return at < 0 ? label : label.slice(at + 3);
}

function Orbits() {
  return (
    <svg
      viewBox="0 0 320 320"
      aria-hidden="true"
      className="h-[260px] w-[260px] text-signal opacity-70"
    >
      {[
        { rx: 138, ry: 52, rot: -22 },
        { rx: 106, ry: 40, rot: 18 },
        { rx: 72, ry: 27, rot: 62 },
      ].map((o, i) => (
        <ellipse
          key={i}
          cx="160"
          cy="160"
          rx={o.rx}
          ry={o.ry}
          transform={`rotate(${o.rot} 160 160)`}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.16 + i * 0.08}
          strokeWidth="1.2"
        />
      ))}
      <circle cx="160" cy="160" r="18" fill="currentColor" />
      <circle cx="288" cy="108" r="5" fill="currentColor" opacity="0.8" />
      <circle cx="62" cy="188" r="3.5" fill="currentColor" opacity="0.6" />
    </svg>
  );
}

function Missing({ title, fix }: { title: string; fix: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg0 p-8">
      <div className="max-w-[480px] space-y-2 text-center">
        <h1 className="text-[20px] font-medium text-ink">{title}</h1>
        <p className="text-[13px] text-ink-mute">{fix}</p>
        <p className="pt-2">
          <Link href="/overview" className="text-[13px] text-signal hover:underline">
            Back to Zenith.ai
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

  const deployment = q.deployment(deploymentId);
  if (!deployment)
    return (
      <Missing
        title="No such deployment"
        fix="This preview address belongs to a deployment that no longer exists. Open the project's Deploys tab to find a current one."
      />
    );

  const revision = q.revision(deployment.revisionId);
  const service = revision?.manifest.services.find((s) => s.id === serviceId);
  const project = q.project(deployment.projectId);
  const env = q.environment(deployment.environmentId);

  if (!service || !project)
    return (
      <Missing
        title="That service is not part of this deployment"
        fix="The address may be from an older revision. Open the deployment in Zenith.ai to see what it actually published."
      />
    );

  const output = deployment.outputs.find((o) => o.targetId === serviceId && o.kind === "url");
  const host = prettyHost(output?.label, `https://${service.name}.${project.slug}.orrery.app`);

  return (
    <div className="min-h-dvh bg-bg0">
      <div className="border-b border-warn/25 bg-warn-dim">
        <div className="mx-auto flex max-w-[900px] flex-wrap items-center justify-between gap-3 px-6 py-2.5">
          <p className="text-[12.5px] text-ink">
            <strong className="font-medium">Simulated preview</strong> — this is what your users
            would see at <span className="font-mono">{host}</span>. Nothing real is being served.
          </p>
          <Link
            href={`/p/${project.slug}`}
            className="text-[12.5px] font-medium text-ink hover:underline"
          >
            Back to {project.name}
          </Link>
        </div>
      </div>

      <main className="mx-auto grid min-h-[calc(100dvh-49px)] max-w-[900px] place-items-center px-6 py-16">
        <div className="flex flex-col items-center text-center">
          <Orbits />
          <p className="mt-8 text-[12px] font-medium tracking-[0.14em] text-ink-faint uppercase">
            {project.name} · {env?.name ?? "environment"}
          </p>
          <h1 className="mt-3 text-[40px] leading-tight font-medium tracking-[-0.02em] text-ink">
            {service.name} is running
          </h1>
          <p className="mt-3 max-w-[52ch] text-[14px] text-ink-mute">
            Your real application would be serving this request. Zenith.ai published{" "}
            <span className="font-mono text-ink">{host}</span>, routed traffic to{" "}
            <span className="font-mono text-ink">{service.name}</span>
            {service.port ? (
              <>
                {" "}
                on port <span className="font-mono text-ink tnum">{service.port}</span>
              </>
            ) : null}
            , and verified it answered before calling the deployment done.
          </p>

          <dl className="mt-8 grid grid-cols-2 gap-x-10 gap-y-3 rounded-card border border-line bg-bg2 px-6 py-4 text-left sm:grid-cols-4">
            {[
              ["Revision", revision ? `r${revision.number}` : "—"],
              ["Kind", service.kind],
              ["Size", `${service.size} × ${service.replicas}`],
              ["Health path", service.healthPath ?? "—"],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-[11px] tracking-[0.04em] text-ink-faint uppercase">{k}</dt>
                <dd className="tnum mt-0.5 font-mono text-[13px] text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </main>
    </div>
  );
}
