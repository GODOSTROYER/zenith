/**
 * The AWS network and edge drivers (WS-AWS-NET): VPC, subnets, security-group
 * rules, load balancer, Route 53 zone and record, ACM certificate. The
 * provider-level `drivers/index.ts` (orchestrator-owned) concatenates this with
 * the other groups and registers them; this module registers nothing itself.
 */
import type { AwsSession } from "@/lib/credentials/types";
import type { ResourceDriver } from "@/lib/drivers/types";
import { acmCertificateDriver } from "./acm-certificate";
import { albDriver } from "./alb";
import { route53RecordDriver } from "./route53-record";
import { route53ZoneDriver } from "./route53-zone";
import { securityGroupRuleDriver } from "./security-group-rule";
import { subnetDriver } from "./subnet";
import { vpcDriver } from "./vpc";

export const networkDrivers: ResourceDriver<AwsSession>[] = [vpcDriver, subnetDriver, securityGroupRuleDriver, albDriver, route53ZoneDriver, route53RecordDriver, acmCertificateDriver];

export { acmCertificateDriver, albDriver, route53RecordDriver, route53ZoneDriver, securityGroupRuleDriver, subnetDriver, vpcDriver };
export { assessRecordDeletion, comparableDnsName, zoneNameOfAddress } from "./route53-record";
export { diffRuleSets, normalizeRule, ruleKey, type NormalizedRule, type RuleDiff } from "./firewall-rules";
export { PUBLIC_HTTP_CAPABILITY, PUBLIC_HTTP_PORTS } from "./firewall-compile";
export { TLS_POLICY } from "./alb-routes";
