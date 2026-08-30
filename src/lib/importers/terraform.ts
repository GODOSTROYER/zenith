/**
 * Terraform → Orrery manifest. PREVIEW-QUALITY, and it says so.
 *
 * This is a regex-level scan of `resource "type" "name"` blocks, not an HCL
 * parse: modules, variables, count/for_each, locals and interpolation are not
 * evaluated. What it recognises is imported as `referenced` — Orrery reads
 * those resources, never provisions or mutates them — so a wrong guess here
 * cannot touch your cloud.
 */
import { id } from "@/lib/domain/types";
import type { Manifest, Resource, ResourceKind } from "@/lib/domain/types";
import { emptyReport, slugify, uniqueName, type ImportReport } from "./types";

export interface TerraformImport {
  manifest: Manifest;
  report: ImportReport;
}

const KNOWN: Record<string, { kind: ResourceKind; label: string }> = {
  aws_db_instance: { kind: "postgres", label: "RDS instance" },
  aws_rds_cluster: { kind: "postgres", label: "RDS cluster" },
  aws_s3_bucket: { kind: "object_store", label: "S3 bucket" },
  aws_sqs_queue: { kind: "queue", label: "SQS queue" },
  aws_elasticache_cluster: { kind: "redis", label: "ElastiCache cluster" },
  aws_elasticache_replication_group: { kind: "redis", label: "ElastiCache replication group" },
};

const RESOURCE_RE = /resource\s+"([A-Za-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"/g;
const BLOCK_RE = /^\s*(module|variable|output|locals|provider|data|terraform)\s/gm;

export const TERRAFORM_IMPORTER_LABEL =
  "Preview-quality importer: a text scan, not an HCL parse. Imported resources are marked 'referenced' — Orrery reads them and never changes them.";

export function importTerraform(text: string): TerraformImport {
  const report = emptyReport();
  report.warnings.push(TERRAFORM_IMPORTER_LABEL);

  const manifest: Manifest = { version: 1, services: [], resources: [], routes: [], bindings: [] };
  const taken: string[] = [];
  let found = 0;

  for (const m of text.matchAll(RESOURCE_RE)) {
    const [, type, tfName] = m;
    found++;
    const known = KNOWN[type];
    const address = `${type}.${tfName}`;
    if (!known) {
      report.unmapped.push({
        source: address,
        reason: `Orrery has no model for ${type} yet.`,
        suggestion:
          type.startsWith("aws_iam") || type.startsWith("aws_security_group") || type.startsWith("aws_vpc")
            ? "Networking and IAM stay yours — Orrery deploys into the account you connect and does not manage them."
            : "Leave it in Terraform. Orrery only needs the resources your services talk to.",
      });
      continue;
    }
    const name = uniqueName(slugify(tfName, known.kind.replace("_", "-")), taken);
    taken.push(name);
    const resource: Resource = {
      id: id(),
      name,
      kind: known.kind,
      config: {},
      size: "small",
      ownership: "referenced",
      externalRef: address,
    };
    manifest.resources.push(resource);
    report.mapped.push({
      source: address,
      result: `referenced resource ${name} (${known.kind})`,
      confidence: "assumed",
      note: `${known.label} recognised by name. Marked 'referenced': Orrery shows it on the map and binds services to it, but never provisions or deletes it — and it does not appear in your Orrery cost estimate.`,
    });
  }

  for (const b of text.matchAll(BLOCK_RE)) {
    const kw = b[1];
    if (report.unmapped.some((u) => u.source === `${kw} blocks`)) continue;
    report.unmapped.push({
      source: `${kw} blocks`,
      reason: `${kw} blocks are not evaluated by this scan.`,
      suggestion:
        kw === "module"
          ? "Resources created inside modules were not seen. Import the module's own .tf files, or add those resources by hand."
          : "Nothing was imported from them; check the map covers everything your services use.",
    });
  }

  if (found === 0) {
    report.unmapped.push({
      source: "(whole file)",
      reason: 'No `resource "type" "name"` blocks were found.',
      suggestion: "Point the importer at the .tf files that declare resources, not at variables or outputs.",
    });
  }
  if (manifest.resources.length === 0) {
    report.warnings.push(
      "Nothing was imported. Add the databases, caches, queues and buckets your services use with system.addResource, or import a docker-compose.yml."
    );
  } else {
    report.warnings.push(
      `${manifest.resources.length} resource(s) imported as 'referenced'. Add your services next — Terraform does not describe what runs your code.`
    );
  }

  return { manifest, report };
}
