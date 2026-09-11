import { ArrowUpRight, Box, Download, FileCode2, FileJson2, FileText } from "lucide-react";
import type { ProviderRow } from "./landing";

const PROVIDER_COPY: Record<string, { title: string; copy: string; note: string }> = {
  sandbox: { title: "Sandbox", copy: "Explore the entire workflow.", note: "Simulated deployment and operations. No infrastructure is provisioned." },
  localstack: { title: "LocalStack", copy: "Real local resources. On your machine.", note: "Supported S3 buckets and SQS queues with Docker + LocalStack. Application services, routes and other emulated behavior remain simulated." },
  aws: { title: "AWS Preview", copy: "Plan here. Apply with your own tools.", note: "Real Terraform export. No in-app AWS apply, account reads or live account verification." },
};

export function ProviderChapter({ providers }: { providers: ProviderRow[] }) {
  const supported = providers.filter((provider) => provider.availability !== "planned");
  const planned = providers.filter((provider) => provider.availability === "planned");
  return (
    <section id="providers" className="zenith-providers" aria-labelledby="zenith-providers-title">
      <div className="zenith-section-heading"><h2 id="zenith-providers-title">Your cloud.<br /><em>Clear boundaries.</em></h2><p>Choose a starting point for the work you can do today. Your connection determines what can run.</p></div>
      <div className="zenith-provider-table">
        <div className="zenith-provider-table-head" aria-hidden="true"><span>Connection</span><span>Availability</span><span>What you can do</span></div>
        {supported.map((provider) => { const presentation = PROVIDER_COPY[provider.id]; return <article className="zenith-provider-row" key={provider.id}><h3><Box size={21} strokeWidth={1.3} aria-hidden="true" />{presentation?.title ?? provider.displayName}</h3><span className="zenith-provider-status" data-availability={provider.availability}><span className="zenith-open-dot" />{provider.availability === "preview" ? "Preview" : "Available"}</span><div><h4>{presentation?.copy ?? provider.tagline}</h4><p>{presentation?.note ?? provider.tagline}</p><details><summary>Provider details</summary><p>{provider.tagline}</p></details></div></article>; })}
      </div>
      <div className="zenith-roadmap"><span>On the horizon</span><ul>{planned.map((provider) => <li key={provider.id}><span>{provider.displayName}</span><span>{provider.id === "azure" || provider.id === "oracle-coming-later" ? "Coming later" : "Planned"}</span></li>)}</ul></div>
      <div className="zenith-ownership">
        <div className="zenith-export-object" aria-label="Export files: the compatible manifest, Terraform, and an operations README"><div><FileJson2 size={21} aria-hidden="true" /><span>zenith.manifest.json</span><span>01</span></div><div><FileCode2 size={21} aria-hidden="true" /><span>Terraform / *.tf</span><span>02</span></div><div><FileText size={21} aria-hidden="true" /><span>Operations / README.md</span><Download size={17} aria-hidden="true" /></div></div>
        <div><h3>The system stays yours.</h3><p>Export the typed manifest, real Terraform, and an operations README. Continue with your own tooling, in your own environment.</p><a href="https://github.com/GODOSTROYER/zenith/blob/master/docs/RUNNING.md" target="_blank" rel="noreferrer" className="zenith-text-link">Read the local setup guide <ArrowUpRight size={16} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a></div>
      </div>
    </section>
  );
}
