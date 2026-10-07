/**
 * GET  /api/platform/v1/mixed/plans?environmentId=   stored mixed parent plans of an environment (read-only)
 * POST /api/platform/v1/mixed/plans                   partition a graph and propose its parent plan; browser-only
 *
 * POST partitions the parent environment's graph over the named child environments
 * (each bound to its own verified connection and state backend), stores the immutable
 * parent plan, then proposes the parent operation through the ordinary capability
 * broker. The proposal input carries the child digest set, so a person's approval of
 * that operation (the existing approve route) approves exactly those children. It
 * grants nothing by itself and starts nothing.
 * Body: `{ parentEnvironmentId, childEnvironmentIds[], pins?, references?, connectivity?, reason? }`.
 * `connectivity` (PROD-MIX-05) declares the protected endpoints (mutual TLS, address allowlist, DNS and TLS pins) or an
 * opted-in VPN between partitions. It is assessed before anything is stored (an unsafe or incomplete declaration refuses
 * the plan) and its digest is part of the approved proposal input.
 */
import { z } from "zod";
import { authorizeEnvironment, publicData } from "@/app/(product)/platform/_lib/read-models";
import { platformBroker } from "@/lib/capabilities/platform";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import { MIXED_PARENT_CAPABILITY } from "@/lib/execution/mixed/types";
import { mixedDeps } from "@/lib/execution/mixed/runtime";
import { planMixed } from "@/lib/execution/mixed/service";
import { assertBrowserSession } from "../../_lib/browser";
import { parseWith, platformRoute, readJson } from "../../_lib/http";
import { guarded } from "../../_lib/mixed";
import { callerOf } from "../../_lib/principal";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const HOST_OR_CIDR = z.string().min(1).max(64);
const VAULT_OR_TEXT = z.string().min(1).max(300);
const HEX64 = z.string().regex(/^[a-f0-9]{64}$/);
const Connectivity = z.object({
  format: z.literal("zenith.mixed-connectivity.v1"),
  networks: z.array(z.object({ partitionId: z.string().min(1).max(200), cidrs: z.array(HOST_OR_CIDR).max(16), egress: z.array(HOST_OR_CIDR).max(32) }).strict()).max(16),
  endpoints: z.array(z.object({
    id: z.string().regex(ID), producerPartitionId: z.string().min(1).max(200), consumerPartitionId: z.string().min(1).max(200),
    dataClass: z.enum(["database", "service", "function"]), mode: z.literal("protected_endpoint"), host: z.string().min(1).max(253), port: z.number().int(),
    dns: z.object({ name: z.string().min(1).max(253), expectedTargets: z.array(z.string().min(1).max(253)).max(16), ttlMaxSeconds: z.number().int() }).strict(),
    tls: z.object({ minVersion: z.enum(["1.2", "1.3"]), serverNames: z.array(z.string().min(1).max(253)).max(16), serverSpkiSha256: HEX64, clientAuth: z.literal("required"), clientCaDigest: HEX64 }).strict(),
    identity: z.object({ clientCertSubject: VAULT_OR_TEXT, consumerConnectionIdentityDigest: HEX64 }).strict(),
    secrets: z.object({ clientKeyRef: VAULT_OR_TEXT, clientCertRef: VAULT_OR_TEXT }).strict(),
    allowlist: z.array(HOST_OR_CIDR).max(32),
  }).strict()).max(32),
  vpn: z.object({
    optIn: z.boolean(),
    links: z.array(z.object({ id: z.string().regex(ID), producerPartitionId: z.string().min(1).max(200), consumerPartitionId: z.string().min(1).max(200), kind: z.enum(["ipsec", "wireguard"]), producerCidr: HOST_OR_CIDR, consumerCidr: HOST_OR_CIDR, keyRef: VAULT_OR_TEXT }).strict()).max(16),
  }).strict().optional(),
}).strict();
const VALUE_TYPE = z.enum(["string", "number", "boolean", "resource_id", "endpoint", "secret_ref"]);
const Body = z.object({
  parentEnvironmentId: z.string().regex(ID),
  childEnvironmentIds: z.array(z.string().regex(ID)).min(1).max(8),
  pins: z.array(z.object({ address: z.string().min(1).max(300), childEnvironmentId: z.string().regex(ID) }).strict()).max(256).optional(),
  references: z.array(z.object({
    id: z.string().regex(ID),
    producer: z.object({ address: z.string().min(1).max(300), output: z.string().min(1).max(300), type: VALUE_TYPE }).strict(),
    consumer: z.object({ address: z.string().min(1).max(300), input: z.string().min(1).max(300), type: VALUE_TYPE }).strict(),
  }).strict()).max(128).optional(),
  connectivity: Connectivity.optional(),
  reason: z.string().max(1000).optional(),
}).strict();

const summary = (stored: plans.StoredMixedPlan) => ({
  parentPlanId: stored.plan.parentPlanId, parentEnvironmentId: stored.plan.parentEnvironmentId, status: stored.status,
  parentDigest: stored.plan.parentDigest, childSetDigest: stored.plan.childSetDigest,
  connectivity: stored.plan.connectivity ? { digest: stored.plan.connectivity.digest, endpoints: stored.plan.connectivity.declaration.endpoints.length, vpn: stored.plan.connectivity.declaration.vpn?.optIn === true } : null, parentOperationId: stored.parentOperationId ?? null, createdAt: stored.createdAt,
  children: stored.plan.children.length,
});

export const GET = platformRoute(async (req) => {
  const caller = await callerOf(req);
  const environmentId = req.nextUrl.searchParams.get("environmentId") ?? "";
  if (!ID.test(environmentId)) return { body: { plans: [] } };
  await authorizeEnvironment({ workspaceId: caller.workspaceId, principal: caller.principal, surface: "rest" }, environmentId, "infrastructure.observe");
  const deps = await mixedDeps();
  const stored = await guarded(() => plans.listPlansForEnvironment(deps.sql, caller.workspaceId, environmentId));
  return { body: { plans: publicData(stored.map(summary)) } };
});

export const POST = platformRoute(async (req) => {
  const caller = await assertBrowserSession(req);
  const body = parseWith(Body, await readJson(req));
  await authorizeEnvironment({ workspaceId: caller.workspaceId, principal: caller.principal, surface: "rest" }, body.parentEnvironmentId, "infrastructure.observe");
  const deps = await mixedDeps();
  const planned = await guarded(() => planMixed(deps, {
    workspaceId: caller.workspaceId, parentEnvironmentId: body.parentEnvironmentId, childEnvironmentIds: body.childEnvironmentIds,
    ...(body.pins ? { pins: body.pins } : {}), ...(body.references ? { references: body.references } : {}),
    ...(body.connectivity ? { connectivity: body.connectivity } : {}), createdBy: caller.principal.id,
  }));
  const broker = await platformBroker();
  // The ordinary proposal path: policy decides, a person approves, nothing here executes. The input IS the approved child set.
  const proposed = await broker.propose({
    capability: MIXED_PARENT_CAPABILITY,
    scope: { workspaceId: caller.workspaceId, projectId: planned.stored.plan.projectId, environmentId: body.parentEnvironmentId },
    input: planned.proposalInput,
    ...(body.reason ? { reason: body.reason } : {}),
    idempotencyKey: `mixed-${planned.stored.plan.parentPlanId.slice(4)}`,
  }, caller.principal, { via: "rest" });
  const attached = await guarded(() => plans.attachParentOperation(deps.sql, { workspaceId: caller.workspaceId, planId: planned.stored.plan.parentPlanId, operationId: proposed.operation.id }));
  return {
    status: planned.created ? 201 : 200,
    body: {
      plan: summary(attached), operationId: proposed.operation.id, operationStatus: proposed.operation.status, decision: proposed.decision.outcome,
      next: "A person approves the operation with the exact child set, adopts one deploy operation per child, then starts the parent.",
    },
  };
});
