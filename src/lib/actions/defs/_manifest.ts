/**
 * Pure validation shared by Source and the manifest-edit actions. Validation
 * never upgrades a document and errors describe fields, never submitted values.
 * Secret detection is conservative: references are allowed; recognizable
 * credentials and secret-named environment values are refused.
 */
import { findSecret } from "@/lib/capabilities/secret-guard";
import { validateManifest } from "@/lib/domain/graph";
import { parseManifest, type ParseManifestResult } from "@/lib/resources/manifest-v2";
import { looksSecretKey } from "@/lib/resources/secrets";

// Record keys are caller-controlled, even when used as a validation path.
const FIELDS = new Set((
  "version services resources routes bindings placement constraints policies nodePlacement providerConfig native release migrate " +
  "provider regions zones residency budgetUsdMonthly availabilityTarget latencyTargetMs userRegions tolerateSingleFailure " +
  "deletion backup approvalRequired allowStatefulDeletion aws gcp azure oci kubernetes vpcCidr natGateways fargatePlatformVersion " +
  "rdsEngineVersion multiAz instanceClassOverrides cloudSqlTier highAvailability cloudRunIngress vnetCidr postgresSku zoneRedundant " +
  "resourceGroup vcnCidr shape namespace ingressClass storageClass id name kind source type image repo ref dockerfile blueprint size " +
  "replicas port healthPath schedule env ownership key value secretRef config externalRef host pathPrefix tls managedDns from to " +
  "capability note region dependsOn service command timeoutSec password token"
).split(" "));

function safeField(path: string): string {
  return path.replace(/\[(\d+)\]/g, ".$1").split(".")
    .map((part) => FIELDS.has(part) || /^\d+$/.test(part) ? part : "[entry]").join(".") || "manifest";
}

export function parseEditableManifest(raw: unknown, structural = true): ParseManifestResult {
  const secret = findSecret(raw);
  if (secret) return { ok: false, errors: [{ path: safeField(secret.path), message: "Use a secret reference instead of an inline credential." }] };
  const parsed = parseManifest(raw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors.map((issue) => ({
    path: safeField(issue.path),
    message: issue.path === "version" ? "version must be 1 or 2." : "Invalid value for this manifest field; check the manifest schema.",
  })) };
  const m = parsed.manifest;
  const unknown = unknownField(raw, m);
  if (unknown) return { ok: false, errors: [{ path: safeField(unknown), message: "Unknown manifest field; remove it instead of discarding it silently." }] };
  for (const [i, service] of m.services.entries()) {
    for (const [j, entry] of service.env.entries()) {
      if (looksSecretKey(entry.key) && entry.value !== undefined)
        return { ok: false, errors: [{ path: `services.${i}.env.${j}.value`, message: "Use secretRef for a secret-named environment variable." }] };
    }
  }
  const issues = structural ? validateManifest(m).filter((issue) => issue.level === "error") : [];
  if (issues.length) return { ok: false, errors: issues.map((issue) => ({
    path: issue.path ?? "manifest", message: "Invalid or conflicting manifest field. Check its required settings and node references before saving.",
  })) };
  // Preserve a complete valid document exactly; keep the schema's established
  // defaults for abbreviated input so stored collection fields remain usable.
  return { ok: true, manifest: containsDefaults(raw, m) ? structuredClone(raw) as typeof m : m };
}

function unknownField(raw: unknown, parsed: unknown, path = ""): string | undefined {
  if (raw === null || typeof raw !== "object" || parsed === null || typeof parsed !== "object") return undefined;
  const output = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    const field = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(output, key)) return field;
    const nested = unknownField(value, output[key], field);
    if (nested) return nested;
  }
  return undefined;
}

function containsDefaults(raw: unknown, parsed: unknown): boolean {
  if (parsed === undefined) return true;
  if (Array.isArray(parsed)) return Array.isArray(raw) && parsed.every((value, i) => containsDefaults(raw[i], value));
  if (parsed !== null && typeof parsed === "object") return raw !== null && typeof raw === "object" &&
    Object.entries(parsed).every(([key, value]) => containsDefaults((raw as Record<string, unknown>)[key], value));
  return Object.is(raw, parsed);
}
