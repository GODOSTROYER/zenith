/**
 * `k8s:DNSEndpoint` — dns_record via external-dns' CRD source.
 *
 * Only the first endpoint is compared; Zenith renders exactly one. Whether
 * external-dns has actually published the record to the zone is not visible
 * from this object and is not claimed.
 */
import type { DnsRecordSpec } from "@/lib/resources/specs";
import { dig, isRecord } from "../../util";
import { compact, safeExpected, sortedStrings } from "../attrs";
import { makeKubernetesDriver, type KindDef } from "../shared";

const endpoint = (live: Record<string, unknown>) => {
  const e = dig(live, "spec", "endpoints", 0);
  return isRecord(e) ? e : undefined;
};

export const dnsEndpointDef: KindDef = {
  suffix: "dnsendpoint",
  nativeType: "k8s:DNSEndpoint",
  kind: "DNSEndpoint",
  portable: ["dns_record"],
  attributes: (live) => {
    const e = endpoint(live);
    return { dnsName: e?.dnsName, recordType: e?.recordType, targets: sortedStrings(e?.targets) };
  },
  expected: safeExpected((node) => {
    const s = node.spec as unknown as Partial<DnsRecordSpec>;
    return typeof s.name === "string" ? { dnsName: s.name } : {};
  }),
  summary: (live) => compact({ dnsName: endpoint(live)?.dnsName, recordType: endpoint(live)?.recordType }),
};

export const dnsEndpointDriver = makeKubernetesDriver(dnsEndpointDef);
