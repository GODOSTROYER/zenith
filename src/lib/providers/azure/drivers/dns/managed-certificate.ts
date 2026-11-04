/**
 * `azure:managed_certificate` — portable `tls_certificate`, realized as a
 * Container Apps environment MANAGED CERTIFICATE (free, auto-renewing,
 * validated by DNS) plus the custom domain on the routed app.
 *
 * Compile (validation `dns_automatic`; the DNS records come from
 * `dns_record/<host>`):
 *   1. `azurerm_container_app_custom_domain` on the routed app, binding
 *      `Disabled` (the hostname is registered, no certificate yet). Its name is
 *      derived from the DNS record's FQDN, which orders it after the CNAME/TXT
 *      records Container Apps validates at creation;
 *   2. `azurerm_container_app_environment_managed_certificate`, whose subject is
 *      that domain, validated by CNAME (subdomain) or HTTP (zone apex).
 *
 * ONE STEP IS NOT DECLARATIVE. Container Apps issues the certificate only
 * after the hostname exists on the app, and binding it is an update of that
 * same hostname (`SniEnabled` + certificate id): tofu cannot express a
 * resource that depends on the certificate while the certificate depends on it.
 * The custom domain therefore ignores its binding fields
 * (`lifecycle.ignore_changes`) and the bind is `bindManagedCertificate`
 * (`certificates.ts`), run by the deploy workflow once the certificate is
 * issued. Until then the host answers with the environment default certificate;
 * the load balancer's observation reports `tlsHostsBound` so the gap is visible,
 * never assumed closed.
 *
 * `dns_manual` (the route has managedDns off) compiles NOTHING: issuance needs
 * the user's DNS records to exist first, and an apply cannot wait for them.
 *
 * Observe reads the certificate in the environment (`managedCertificates`),
 * found through the landing zone's environment; expected is the subject name.
 * Certificate issuance state is a verify check (`Succeeded`), not a config value.
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { LoadBalancerSpec, TlsCertificateSpec } from "@/lib/resources/specs";
import { AzureCompileError, block, fragment, mergeBlocks, requireNode, resolveNetwork, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { defineAzureDriver, getById, locatedFromError, pick, props, type AzureCtx, type Located } from "@/lib/providers/azure/kit";
import { armClient, type ArmResource } from "@/lib/providers/azure/arm";
import { azureTags, scopedName, tfLabel } from "@/lib/providers/azure/naming";
import { API } from "@/lib/providers/azure/platform";
import { LOAD_BALANCER_ADDRESS } from "@/lib/providers/azure/drivers/compute/load-balancer";
import { findLandingZoneTagged } from "@/lib/providers/azure/drivers/network/landing";

export function compileManagedCertificate(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<TlsCertificateSpec>(node);
  const a = node.address;
  if (spec.validation !== "dns_automatic") return fragment({});
  const lb = requireNode(ctx, LOAD_BALANCER_ADDRESS, "the load balancer that routes the domain", a);
  const route = (specOf<LoadBalancerSpec>(lb).routes ?? []).find((r) => r.host.toLowerCase() === spec.domain.toLowerCase());
  if (!route) throw new AzureCompileError(`no route of ${LOAD_BALANCER_ADDRESS} serves ${spec.domain}; a managed certificate needs a container app to bind to.`, a);
  const dnsRecord = `dns_record/${spec.domain.toLowerCase()}`;
  requireNode(ctx, dnsRecord, "the DNS record that validates the domain", a);
  const zoneName = spec.zone ? (requireNode(ctx, spec.zone, "the certificate's zone", a).spec as { name?: string }).name : undefined;
  const apex = zoneName !== undefined && zoneName.toLowerCase() === spec.domain.toLowerCase();
  const net = resolveNetwork(node, ctx);
  const L = (part: string) => tfLabel(a, part);
  const domain = `azurerm_container_app_custom_domain.${L("domain")}`;
  const resource = mergeBlocks(
    block("azurerm_container_app_custom_domain", L("domain"), {
      name: `\${trimsuffix(${exportRef(dnsRecord, "fqdn").slice(2, -1)}, ".")}`,
      container_app_id: exportRef(route.target, "id"),
      certificate_binding_type: "Disabled",
      lifecycle: { ignore_changes: ["certificate_binding_type", "container_app_environment_certificate_id"] },
    }),
    block("azurerm_container_app_environment_managed_certificate", L("cert"), {
      name: scopedName(a, { max: 60, suffix: "cert" }),
      container_app_environment_id: exportRef(net, "cae_id"),
      subject_name: `\${${domain}.name}`,
      domain_control_validation: apex ? "HTTP" : "CNAME",
      tags: azureTags(ctx, node),
    })
  );
  return fragment({ resource, locals: exportLocals(a, { id: `\${azurerm_container_app_environment_managed_certificate.${L("cert")}.id}` }) });
}

/* --------------------------------- observe ---------------------------------- */

const CAE = "Microsoft.App/managedEnvironments";

async function locateCertificate(ctx: AzureCtx, node: ResourceNode, externalId?: string): Promise<Located> {
  const arm = armClient(ctx.session, ctx.signal);
  if (externalId) return getById(arm, externalId, API.containerApps);
  const spec = specOf<TlsCertificateSpec>(node);
  const env = await findLandingZoneTagged(ctx, node, arm, CAE);
  if (!("matches" in env)) return env;
  if (env.matches.length !== 1) return env.matches.length === 0 ? { state: "missing" } : { state: "unknown", detail: `ambiguous: ${env.matches.length} environments` };
  try {
    const { items } = await arm.list<ArmResource>(`${env.matches[0].id}/managedCertificates`, { apiVersion: API.containerApps }, 3);
    const hit = items.filter((c) => String(pick<string>(c, "properties", "subjectName") ?? "").toLowerCase() === spec.domain.toLowerCase());
    if (hit.length === 0) return { state: "missing" };
    return { state: "found", resource: hit[0] };
  } catch (e) {
    return locatedFromError(e, false);
  }
}

export const managedCertificateDriver = defineAzureDriver({
  id: "azure.managed_certificate@1",
  kind: "tls_certificate",
  nativeType: "azure:managed_certificate",
  locate: (ctx, node, id) => locateCertificate(ctx, node, id),
  compile: compileManagedCertificate,
  expected: (node) => ({ subjectName: specOf<TlsCertificateSpec>(node).domain.toLowerCase() }),
  read: (res) => ({ subjectName: pick<string>(props(res), "subjectName")?.toLowerCase() }),
  native: (res) => ({ provisioningState: props(res).provisioningState, validationMethod: props(res).domainControlValidation, error: props(res).error }),
  checks: (_ctx, _node, res) => {
    const state = pick<string>(props(res), "provisioningState");
    return [{ id: "issued", description: "the certificate is issued", passed: state === "Succeeded" ? true : state === "Failed" || state === "Canceled" ? false : ("unknown" as const), detail: `provisioningState=${String(state)}` }];
  },
});

