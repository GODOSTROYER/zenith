/**
 * Ensure/teardown platform TLS under the environment's operator lease. The
 * caller must serialize apply and destroy for the same environment. Separate
 * environments never edit shared listeners. Ownership is checked before any
 * write and again immediately before each write; API preconditions fence races.
 * Partial work is reported, never rolled back across phases. TLS readiness is
 * unknown: accepting desired objects does not prove certificate issuance.
 */
import { toK8sError } from "@/lib/providers/kubernetes/client";
import { OWNERSHIP, dig, type K8sObject, type ObjectRef } from "./k8s-port";
import { assertSessionMatches, type ZenithSession } from "./session";
import { createTlsObjectClient, type TlsObjectClient } from "./tls-client";
import { CERTIFICATE_API_VERSION, PLATFORM_TLS_LABEL, platformTlsMetadata, renderEnvironmentTls } from "./tls";
import { TENANT_ANNOTATION } from "./types";

export interface ZenithTlsInput {
  session: ZenithSession;
  expect: { workspaceId: string; environmentId: string };
  /** Injectable contract port; production uses the separate gateway operator session. */
  tlsClient?: TlsObjectClient;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** Verified custom domains to serve (PROD-MAN-03): each gets its own listener and Certificate. */
  customDomains?: readonly string[];
  /** Custom domains that lapsed or were revoked: their Certificate and key Secret are removed when owned. */
  retiredDomains?: readonly string[];
}

export interface ZenithTlsReport {
  ok: boolean;
  dryRun: boolean;
  /** Desired objects are not evidence of successful issuance, DNS or public HTTPS. */
  readiness: "unknown";
  results: { ref: ObjectRef; status: "created" | "configured" | "deleted" | "absent" | "error" | "ownership_conflict" | "conflict" | "uncertain"; errorCode?: string }[];
}

const refOf = (obj: K8sObject): ObjectRef => ({ apiVersion: obj.apiVersion, kind: obj.kind, namespace: obj.metadata.namespace, name: obj.metadata.name });

function objectsFor(input: ZenithTlsInput): K8sObject[] {
  assertSessionMatches(input.session, input.expect);
  return renderEnvironmentTls(input.session.tenant, input.session.substrate, { customDomains: input.customDomains });
}

function secretFor(input: ZenithTlsInput, host?: string): K8sObject {
  return { apiVersion: "v1", kind: "Secret", metadata: platformTlsMetadata(input.session.tenant, input.session.substrate, "Secret", host) };
}

/** Key Secrets of every custom domain this call serves or retires: all protected from relabelling and adoption. */
function customSecrets(input: ZenithTlsInput, hosts: readonly string[]): K8sObject[] {
  return input.session.substrate.gateway.mode === "gateway_api" ? [...new Set(hosts)].sort().map((h) => secretFor(input, h)) : [];
}

function retiredObjects(input: ZenithTlsInput): K8sObject[] {
  const serving = new Set(input.customDomains ?? []);
  const { tenant, substrate } = input.session;
  if (substrate.gateway.mode !== "gateway_api") return [];
  return [...new Set(input.retiredDomains ?? [])].filter((h) => !serving.has(h)).sort().flatMap((h) => [
    { apiVersion: CERTIFICATE_API_VERSION, kind: "Certificate", metadata: platformTlsMetadata(tenant, substrate, "Certificate", h) } satisfies K8sObject,
    secretFor(input, h),
  ]);
}

function owned(live: Record<string, unknown>, desired: K8sObject): boolean {
  return dig(live, "metadata", "name") === desired.metadata.name && dig(live, "metadata", "namespace") === desired.metadata.namespace
    && dig(live, "metadata", "labels", OWNERSHIP.managedByLabel) === OWNERSHIP.managedByValue
    && dig(live, "metadata", "labels", PLATFORM_TLS_LABEL) === "true"
    && [OWNERSHIP.environmentAnnotation, OWNERSHIP.resourceAnnotation, TENANT_ANNOTATION.workspaceId]
      .every((key) => dig(live, "metadata", "annotations", key) === desired.metadata.annotations?.[key]);
}

function clientFor(input: ZenithTlsInput): TlsObjectClient {
  if (input.tlsClient) return input.tlsClient;
  if (!input.session.gatewayKubernetes) throw new Error("TLS operator session unavailable");
  return createTlsObjectClient(input.session.gatewayKubernetes, input.session.substrate.gateway.namespace, { signal: input.signal });
}

function failure(report: ZenithTlsReport, ref: ObjectRef, error: unknown, writing: boolean): ZenithTlsReport {
  const code = toK8sError(error).code;
  // Never copy an external error message, body, arbitrary code or Secret value into the report.
  const status = code === "field_conflict" ? "conflict" : writing && ["aborted", "timeout", "unreachable", "api_error"].includes(code) ? "uncertain" : "error";
  report.ok = false;
  report.results.push({ ref, status, errorCode: code });
  return report;
}

async function check(client: TlsObjectClient, object: K8sObject, report: ZenithTlsReport): Promise<Record<string, unknown> | undefined> {
  const live = await client.read(refOf(object));
  if (live && !owned(live, object)) {
    report.ok = false;
    report.results.push({ ref: refOf(object), status: "ownership_conflict", errorCode: "ownership_conflict" });
  }
  return live;
}

/** Called after tenant isolation and before any workload route attaches. */
export async function ensureZenithTls(input: ZenithTlsInput): Promise<ZenithTlsReport> {
  const objects = objectsFor(input);
  const report: ZenithTlsReport = { ok: true, dryRun: input.dryRun === true, readiness: "unknown", results: [] };
  if (objects.length === 0) return report;
  let current = objects[0];
  let writing = false;
  try {
    input.signal?.throwIfAborted();
    const client = clientFor(input);
    // Also protect the key name: secretTemplate must never relabel an unrelated Secret.
    const retired = retiredObjects(input);
    for (const object of [...objects, secretFor(input), ...customSecrets(input, input.customDomains ?? []), ...retired]) {
      current = object;
      await check(client, object, report);
      if (!report.ok) return report;
    }
    for (const object of objects) {
      current = object;
      input.signal?.throwIfAborted();
      const live = await check(client, object, report);
      if (!report.ok) return report;
      // Recheck the generated key before changing the Certificate's secretTemplate.
      if (object.kind === "Certificate") {
        const host = object.spec && Array.isArray(object.spec.dnsNames) && !String(object.spec.dnsNames[0]).startsWith("*") ? String(object.spec.dnsNames[0]) : undefined;
        await check(client, secretFor(input, host), report);
        if (!report.ok) return report;
      }
      writing = true;
      await client.apply(object, live, report.dryRun);
      writing = false;
      report.results.push({ ref: refOf(object), status: live ? "configured" : "created" });
    }
    // Retired custom domains: their listener is already gone from the Gateway above; remove the Certificate, then the key.
    for (const object of retired) {
      current = object;
      input.signal?.throwIfAborted();
      const live = await check(client, object, report);
      if (!report.ok) return report;
      if (!live) { report.results.push({ ref: refOf(object), status: "absent" }); continue; }
      writing = true;
      try { await client.delete(refOf(object), live, report.dryRun); }
      catch (error) { if (toK8sError(error).code !== "not_found") throw error; }
      writing = false;
      report.results.push({ ref: refOf(object), status: "deleted" });
    }
    return report;
  } catch (error) {
    return failure(report, refOf(current), error, writing);
  }
}

/** Remove the environment Gateway/listener, Certificate, then its labeled key; absent is idempotent. */
export async function teardownZenithTls(input: ZenithTlsInput): Promise<ZenithTlsReport> {
  const desired = objectsFor(input);
  const report: ZenithTlsReport = { ok: true, dryRun: input.dryRun === true, readiness: "unknown", results: [] };
  if (desired.length === 0) return report;
  // every custom domain still named (served or retired) goes too; the Gateway is deleted first, then Certificates, then keys
  const objects = [...desired].reverse().concat(secretFor(input), ...customSecrets(input, input.customDomains ?? []), ...retiredObjects(input));
  let current = objects[0];
  let writing = false;
  try {
    input.signal?.throwIfAborted();
    const client = clientFor(input);
    for (const object of objects) {
      current = object;
      await check(client, object, report);
      if (!report.ok) return report;
    }
    for (const object of objects) {
      current = object;
      input.signal?.throwIfAborted();
      const live = await check(client, object, report);
      if (!report.ok) return report;
      if (!live) { report.results.push({ ref: refOf(object), status: "absent" }); continue; }
      writing = true;
      try { await client.delete(refOf(object), live, report.dryRun); }
      catch (error) { if (toK8sError(error).code !== "not_found") throw error; }
      writing = false;
      report.results.push({ ref: refOf(object), status: "deleted" });
    }
    return report;
  } catch (error) {
    return failure(report, refOf(current), error, writing);
  }
}
