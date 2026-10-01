/** Synthetic OCI API behind the actual runner serializer/allowlist; no live tenancy. */
import { vi } from "vitest";
import type { OciSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import { createRunnerOciTransport, type OciHttpJobPayload } from "@/lib/providers/oci/runner-transport";
import type { OciApiRequest, OciApiResponse } from "@/lib/providers/oci/transport";
import { expandOci, nodeOf, COMPARTMENT, ENV_ID, REGION, TENANCY, ocid, zenithTagsFor } from "./_support";

export const DIGEST = `sha256:${"a".repeat(64)}`;
export const IMAGE = `iad.ocir.io/acme/app@${DIGEST}`;
export const service = { ...nodeOf(expandOci(), "container_service/web"),
  spec: { ...nodeOf(expandOci(), "container_service/web").spec, artifact: { type: "image", ref: IMAGE },
    replicas: 2, env: [{ key: "LOG_LEVEL", value: "info" }, { key: "DATABASE_PASSWORD", secretRef: "vault:DB_PASSWORD" }] } };
export const command = ["node", "migrate.js", "$(external-data)"];
export const migrationOpts = { idempotencyKey: "op:migrate", timeoutMs: 2000 };
export const vnicId = ocid("vnic", "private");
export type Native = Record<string, unknown>;

export function world(capability = "deployment.deploy") {
  const jobs: OciHttpJobPayload[] = [];
  const objects = new Map<string, Native>();
  const containers = new Map<string, Native>();
  for (let n = 0; n < 2; n++) {
    const iid = ocid("computecontainerinstance", `replica${n}`);
    const cid = ocid("computecontainer", `replica${n}`);
    objects.set(iid, { id: iid, compartmentId: COMPARTMENT, freeformTags: zenithTagsFor(service.address),
      lifecycleState: "ACTIVE", availabilityDomain: "abc:US-ASHBURN-AD-1", shape: "CI.Standard.E4.Flex",
      shapeConfig: { ocpus: 1, memoryInGBs: 2 }, containerRestartPolicy: "ALWAYS",
      containers: [{ containerId: cid }], vnics: [{ vnicId }] });
    containers.set(cid, { id: cid, containerInstanceId: iid, compartmentId: COMPARTMENT, imageUrl: IMAGE,
      lifecycleState: "ACTIVE", isResourcePrincipalDisabled: false, environmentVariables: {
        LOG_LEVEL: "info", ZENITH_SECRET_OCID_DATABASE_PASSWORD: ocid("vaultsecret", "db"),
        UNDECLARED_SECRET: "PRIVATE_CLOUD_ENV_CANARY" }, healthChecks: [{ statusDetails: "RAW_LOG_CANARY" }] });
  }
  const vnic: Native = { id: vnicId, compartmentId: COMPARTMENT, subnetId: ocid("subnet", "private"), nsgIds: [ocid("networksecuritygroup", "web")] };
  const state: { launches: number; exitCode?: number; lifecycle: string; throwAfterLaunch: boolean;
    override?: (req: OciApiRequest) => OciApiResponse | undefined } = { launches: 0, exitCode: 0, lifecycle: "INACTIVE", throwAfterLaunch: false };
  const tokens = new Map<string, string>();
  const ok = (body: unknown, status = 200): OciApiResponse => ({ status, body, headers: {} });
  const dispatch = vi.fn(async (p: OciHttpJobPayload) => {
    jobs.push(p);
    const req: OciApiRequest = { ...p, query: Object.fromEntries(p.query),
      body: p.bodyB64 ? JSON.parse(Buffer.from(p.bodyB64, "base64").toString("utf8")) : undefined };
    let res = state.override?.(req);
    if (!res) {
      if (p.method === "GET" && p.path === "/20210415/containerInstances") res = ok({ items: [...objects.values()] });
      else if (p.method === "GET" && p.path.startsWith("/20210415/containerInstances/")) res = ok(objects.get(p.path.split("/").at(-1)!));
      else if (p.method === "GET" && p.path.startsWith("/20210415/containers/")) res = ok(containers.get(p.path.split("/").at(-1)!));
      else if (p.method === "GET" && p.path === `/20160918/vnics/${vnicId}`) res = ok(vnic);
      else if (p.method === "POST" && p.path === "/20210415/containerInstances") {
        const token = p.headers["opc-retry-token"];
        let iid = tokens.get(token);
        if (!iid) {
          iid = ocid("computecontainerinstance", `migration${++state.launches}`);
          tokens.set(token, iid);
          const cid = ocid("computecontainer", `migration${state.launches}`);
          const body = req.body as Native;
          objects.set(iid, { ...body, id: iid, containers: [{ containerId: cid }], lifecycleState: "ACTIVE" });
          containers.set(cid, { ...(body.containers as Native[])[0], id: cid, compartmentId: COMPARTMENT,
            containerInstanceId: iid, lifecycleState: state.lifecycle, exitCode: state.exitCode });
        }
        if (state.throwAfterLaunch) throw new Error("PRIVATE_PROVIDER_BODY_CANARY");
        res = ok({ id: iid }, 202);
      } else res = { status: 404, headers: {}, body: { message: "PRIVATE_PROVIDER_BODY_CANARY" } };
    }
    return { status: res.status, headers: res.headers,
      ...(res.body !== undefined ? { bodyB64: Buffer.from(JSON.stringify(res.body)).toString("base64") } : {}) };
  });
  const session: OciSession = { provider: "oci", region: REGION, compartmentOcid: COMPARTMENT, tenancyOcid: TENANCY,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), capability,
    scope: { workspaceId: "ws_1", environmentId: ENV_ID, resources: [] }, transport: createRunnerOciTransport(dispatch, { capability }) };
  const ctx: DriverContext<OciSession> = { provider: "oci", region: REGION, workspaceId: "ws_1", environmentId: ENV_ID,
    operationId: "op_oci", signal: new AbortController().signal, session, now: () => new Date(), log: vi.fn(), tags: {} };
  return { ctx, jobs, objects, containers, vnic, state, dispatch };
}
