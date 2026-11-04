/**
 * Bind an issued Container Apps managed certificate to its custom domain.
 *
 * The one non-declarative step of the TLS chain (see
 * `drivers/dns/managed-certificate.ts`): tofu registers the hostname on the app
 * with binding `Disabled` and asks for the certificate; once the certificate is
 * `Succeeded`, this flips the hostname to `SniEnabled` with that certificate id
 * — the equivalent of `az containerapp hostname bind`.
 *
 *   1. find the certificate in the environment by subject name; not issued yet
 *      ⇒ `pending` (nothing is changed);
 *   2. read the app's current custom domains; already bound to that certificate
 *      ⇒ `already_bound` (idempotent);
 *   3. PATCH the app (JSON merge patch: arrays replace, so the FULL domain list
 *      is sent with only this entry changed).
 *
 * Every id that goes into a URL or body comes from an ARM response or from a
 * validated ARM id in this subscription — never from free-form input. The app
 * must carry this environment's Zenith tags.
 *
 * Honest limit: contract-tested against a fake ARM only; the exact behaviour of
 * `customDomains` PATCH on a live app (and propagation delay before HTTPS works)
 * is unverified.
 */
import type { AzureSession } from "@/lib/credentials/types";
import { armClient, ArmError, armTypeOf, inSubscription, pollOperation, sameArmType, type ArmResource, type Json } from "@/lib/providers/azure/arm";
import { pick, props } from "@/lib/providers/azure/kit";
import { API } from "@/lib/providers/azure/platform";

export interface BindCertificateInput {
  /** ARM id of the container app (from the node's observation/export) */
  appId: string;
  /** ARM id of the Container Apps environment */
  environmentId: string;
  /** the custom domain / certificate subject */
  domain: string;
  /** tags the app must carry (this environment + resource), checked before any change */
  expectTags: { environment: string; resource: string };
  clientRequestId?: string;
}

export type BindCertificateResult =
  | { status: "bound" | "already_bound"; certificateId: string; requestIds: string[] }
  | { status: "pending" | "missing_certificate" | "refused"; detail: string; requestIds: string[] };

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export async function bindManagedCertificate(session: AzureSession, input: BindCertificateInput, signal?: AbortSignal): Promise<BindCertificateResult> {
  const requestIds: string[] = [];
  const domain = input.domain.toLowerCase();
  if (!DOMAIN.test(domain)) return { status: "refused", detail: "not a valid domain name", requestIds };
  for (const [id, type] of [[input.appId, "Microsoft.App/containerApps"], [input.environmentId, "Microsoft.App/managedEnvironments"]] as const) {
    const t = armTypeOf(id);
    if (!t || !sameArmType(t, type) || !inSubscription(id, session.subscriptionId)) return { status: "refused", detail: `${type} id is not a resource of this subscription`, requestIds };
  }
  const arm = armClient(session, signal);
  const headers = input.clientRequestId ? { "x-ms-client-request-id": input.clientRequestId.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80) } : undefined;

  const certs = await arm.list<ArmResource>(`${input.environmentId}/managedCertificates`, { apiVersion: API.containerApps }, 3);
  requestIds.push(...certs.requestIds);
  const cert = certs.items.find((c) => String(pick<string>(c, "properties", "subjectName") ?? "").toLowerCase() === domain);
  if (!cert) return { status: "missing_certificate", detail: "no managed certificate for this domain exists in the environment", requestIds };
  const state = pick<string>(props(cert), "provisioningState");
  if (state !== "Succeeded") return { status: "pending", detail: `certificate provisioningState=${String(state)}`, requestIds };

  const app = await arm.get<ArmResource>(input.appId, { apiVersion: API.containerApps });
  if (app.requestId) requestIds.push(app.requestId);
  const tags = app.body.tags ?? {};
  if (tags["zenith:managed"] !== "true" || tags["zenith:environment"] !== input.expectTags.environment || tags["zenith:resource"] !== input.expectTags.resource) {
    return { status: "refused", detail: "the app does not carry this environment's Zenith tags", requestIds };
  }
  const domains = (pick<Json[]>(props(app.body), "configuration", "ingress", "customDomains") ?? []).map((d) => ({ name: String(d.name), bindingType: String(d.bindingType), certificateId: d.certificateId === undefined ? undefined : String(d.certificateId) }));
  const existing = domains.find((d) => d.name.toLowerCase() === domain);
  if (!existing) return { status: "refused", detail: "the hostname is not registered on the app yet (apply the custom domain first)", requestIds };
  if (existing.bindingType === "SniEnabled" && existing.certificateId?.toLowerCase() === cert.id.toLowerCase()) return { status: "already_bound", certificateId: cert.id, requestIds };

  const next = domains.map((d) => (d === existing ? { name: d.name, bindingType: "SniEnabled", certificateId: cert.id } : { name: d.name, bindingType: d.bindingType, ...(d.certificateId ? { certificateId: d.certificateId } : {}) }));
  try {
    const r = await arm.patch(input.appId, { apiVersion: API.containerApps, headers, body: { location: app.body.location, properties: { configuration: { ingress: { customDomains: next } } } } });
    if (r.requestId) requestIds.push(r.requestId);
    const outcome = await pollOperation(session, r, { signal });
    requestIds.push(...outcome.requestIds);
    if (outcome.state === "failed") return { status: "refused", detail: outcome.detail ?? "the update reported failure", requestIds };
    return { status: "bound", certificateId: cert.id, requestIds };
  } catch (e) {
    if (e instanceof ArmError) return { status: "refused", detail: e.message, requestIds: [...requestIds, ...(e.requestId ? [e.requestId] : [])] };
    throw e;
  }
}
