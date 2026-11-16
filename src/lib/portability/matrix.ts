/**
 * The support matrix: which provider and kind can do which portability
 * operation, and the exact reason when one cannot. Everything the broker, the
 * worker and the docs say about support comes from here, so an unsupported
 * combination is refused with a sentence rather than failing half way.
 *
 * What "supported" means for export and import:
 *   postgres      SQL logical copy of tables, enums, sequences, constraints and
 *                 indexes in user schemas (any provider; the worker must reach
 *                 the service with the connection secret the tenant registered).
 *                 Views, functions, triggers, extensions and custom types other
 *                 than enums are REFUSED, never silently dropped.
 *   mysql         mysqldump/mysql CLI copy of tables, views and triggers.
 *                 Routines and events are refused. Needs the CLIs on the worker.
 *   object_store  object-for-object copy through the S3 API (AWS S3, LocalStack,
 *                 and S3-compatible endpoints such as GCS interoperability and
 *                 OCI's S3 compatibility API). Azure Blob has no S3 API and is
 *                 unsupported.
 *   volume        no data mover exists (a PVC or disk cannot be read without a
 *                 workload mounting it): unsupported, explicitly.
 *
 * Adopt and release need only an observable identity and a human claim, so they
 * are supported wherever a real driver can observe the resource.
 */
import type { DataKind, PortabilityOperation, Support } from "./types";
import { isDataKind } from "./types";

const REAL = new Set(["aws", "gcp", "azure", "oci", "kubernetes", "zenith", "localstack"]);

const unsupported = (reason: string): Support => ({ supported: false, reason });

function exportImport(provider: string, kind: DataKind): Support {
  if (!REAL.has(provider)) return unsupported(`${provider} environments have no real data service to copy; export and import need a live service.`);
  switch (kind) {
    case "postgres":
      if (provider === "localstack") return unsupported("LocalStack does not run a Postgres service Zenith can connect to.");
      return { supported: true, method: "postgres-logical-v1", evidence: "local_engine", note: "tables, enums, sequences, constraints, indexes; other object classes are refused" };
    case "mysql":
      if (provider === "zenith") return unsupported("The Zenith-managed database service is Postgres only; there is no managed MySQL.");
      if (provider === "localstack") return unsupported("LocalStack does not run a MySQL service Zenith can connect to.");
      return { supported: true, method: "mysql-cli-v1", evidence: "contract", note: "needs mysqldump and mysql on the worker; tables, views, triggers; routines and events are refused" };
    case "object_store":
      if (provider === "azure") return unsupported("Azure Blob Storage has no S3 API, and the object engine speaks only S3.");
      if (provider === "zenith") return unsupported("The Zenith-managed object store is not provisioned yet, so there is nothing to copy.");
      if (provider === "kubernetes") return unsupported("Kubernetes has no object storage kind.");
      return { supported: true, method: "s3-objects-v1", evidence: "local_engine", note: "object bodies and content type; user metadata, versions and ACLs are not carried" };
    case "volume":
      return unsupported("A volume or PVC cannot be read without a workload that mounts it, and Zenith has no data mover; use the provider's snapshot or a workload-level backup.");
  }
}

function adoptRelease(provider: string, kind: DataKind): Support {
  if (!REAL.has(provider)) return unsupported(`${provider} environments have no real resource to adopt.`);
  if (provider === "zenith") return unsupported("Zenith-managed resources are created by Zenith itself; there is no existing object to adopt, and the managed platform has no observe session for a claim.");
  return { supported: true, method: "observed identity + human ownership claim", evidence: "contract", note: kind === "volume" ? "ownership and drift baseline only; no data copy" : undefined };
}

export function portabilitySupport(operation: PortabilityOperation, provider: string, kind: string): Support {
  if (!isDataKind(kind)) return unsupported(`${kind} is not a data service kind (postgres, mysql, object_store, volume).`);
  return operation === "export" || operation === "import" ? exportImport(provider, kind) : adoptRelease(provider, kind);
}

/** Every combination, for docs and tests. */
export function supportTable(providers: readonly string[] = ["aws", "gcp", "azure", "oci", "kubernetes", "zenith", "localstack", "sandbox"]): { provider: string; kind: DataKind; export: Support; import: Support; adopt: Support; release: Support }[] {
  const kinds: DataKind[] = ["postgres", "mysql", "object_store", "volume"];
  return providers.flatMap((provider) =>
    kinds.map((kind) => ({
      provider,
      kind,
      export: portabilitySupport("export", provider, kind),
      import: portabilitySupport("import", provider, kind),
      adopt: portabilitySupport("adopt", provider, kind),
      release: portabilitySupport("release", provider, kind),
    }))
  );
}
