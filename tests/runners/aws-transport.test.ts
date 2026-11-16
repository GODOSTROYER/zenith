/**
 * AWS SDK v3 over a runner, end to end: REAL SDK clients (ECS, STS, EC2, S3, Lambda, Route 53), the real
 * enqueue → poll → result → await path through the route handlers, and a fake runner that decodes the
 * `aws.http` job, asserts what it was sent, and answers with canned responses in each AWS protocol.
 *
 * What this proves: the unsigned request the SDK serializes arrives intact (method, https URL with
 * query, headers minus credentials, body bytes), the right SigV4 service and region travel with it,
 * and the runner's response is deserialized by the SDK's own deserializers. What it does NOT prove:
 * SigV4 signing or AWS's answers — the runner signs, and there is no AWS here; the bodies below are
 * canned in the documented wire shapes (JSON 1.1, query/XML, REST-XML, REST-JSON).
 */
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { DescribeServicesCommand, ECSClient } from "@aws-sdk/client-ecs";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { ListHostedZonesCommand, Route53Client } from "@aws-sdk/client-route-53";
import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as pollRunner } from "@/app/api/platform/v1/runners/[id]/poll/route";
import { POST as registerRunner } from "@/app/api/platform/v1/runners/register/route";
import { POST as resultRunner } from "@/app/api/platform/v1/runners/[id]/jobs/[jti]/result/route";
import { createRunnerAwsSessionClientFactory, createRunnerAwsTransportFactory, RunnerTransportError } from "@/lib/runners/aws-runner-transport";
import { RunnerJobError } from "@/lib/runners/dispatch";
import type { AwsClientCtor } from "@/lib/credentials/types";
import type { AwsConnectionConfig, ProviderConnection } from "@/lib/credentials/types";
import { verifyCapabilityGrant } from "@/lib/credentials/grants";
import * as repos from "@/lib/controlplane/db/repos";
import { FakeAgent, FakeRunnerService, OPERATION, createPlane, openDbPlane, registerFakeAgent, runnerGrant, teardownPlane, type AgentResultBody, type DbPlane, type DecodedJob, type Plane } from "./_support";

let plane: Plane;
let agent: FakeAgent;
let service: FakeRunnerService | undefined;
beforeEach(async () => {
  plane = await createPlane("real");
  agent = await registerFakeAgent(plane, registerRunner);
});
afterEach(async () => {
  await service?.stop();
  service = undefined;
  teardownPlane();
});

interface AwsJob {
  service: string;
  region: string;
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  bodyB64?: string;
}
const payloadOf = (job: DecodedJob): AwsJob => job.claims.payload as AwsJob;
const bodyOf = (p: AwsJob): string => Buffer.from(p.bodyB64 ?? "", "base64").toString("utf8");

/** What the runner sends back (`{status, headers, bodyB64}` inside a succeeded result). */
const reply = (status: number, headers: Record<string, string>, body: string | Buffer = ""): AgentResultBody => ({
  status: "succeeded",
  result: { status, headers, bodyB64: Buffer.from(body).toString("base64") },
});

const FORBIDDEN = ["authorization", "x-amz-security-token", "x-amz-date"];
function assertUnsigned(p: AwsJob): void {
  const names = Object.keys(p.headers).map((h) => h.toLowerCase());
  for (const h of FORBIDDEN) expect(names, `the job must not carry ${h}`).not.toContain(h);
  expect(names.filter((h) => h.startsWith("x-zenith")), "internal recording headers never leave the control plane").toEqual([]);
  expect(names).not.toContain("host");
  expect(names).not.toContain("content-length");
  // and nothing credential-shaped is anywhere in the serialized job
  expect(JSON.stringify(p)).not.toMatch(/AKIA[0-9A-Z]{16}|zenith-runner-transport|Credential=|Signature=/);
}

async function start(handler: (job: DecodedJob, p: AwsJob) => AgentResultBody | Promise<AgentResultBody>): Promise<FakeRunnerService> {
  service = new FakeRunnerService(agent, { poll: pollRunner, result: resultRunner }, (job) => handler(job, payloadOf(job))).start();
  return service;
}

async function client<C>(ctor: AwsClientCtor<C>, region = "us-east-1", over: Partial<Parameters<typeof createRunnerAwsSessionClientFactory>[0]> = {}): Promise<C> {
  const grant = await runnerGrant(plane, { runnerId: agent.id, workspaceId: agent.workspaceId, operationId: OPERATION, capability: "infrastructure.observe" });
  return createRunnerAwsSessionClientFactory({ runnerId: agent.id, workspaceId: agent.workspaceId, operationId: OPERATION, grant, region, timeoutSec: 30, queueTtlSec: 30, ...over })(ctor);
}

describe("JSON protocol (ECS)", () => {
  it("DescribeServices: the SDK request arrives unsigned and intact, and the canned response is deserialized", async () => {
    await start((_job, p) => {
      assertUnsigned(p);
      expect(p).toMatchObject({ service: "ecs", region: "us-east-1", method: "POST", url: "https://ecs.us-east-1.amazonaws.com/" });
      expect(p.headers["x-amz-target"]).toBe("AmazonEC2ContainerServiceV20141113.DescribeServices");
      expect(p.headers["content-type"]).toBe("application/x-amz-json-1.1");
      expect(JSON.parse(bodyOf(p))).toEqual({ cluster: "prod", services: ["web"] });
      return reply(200, { "content-type": "application/x-amz-json-1.1", "x-amzn-requestid": "req-ecs-1" }, JSON.stringify({ services: [{ serviceName: "web", status: "ACTIVE", desiredCount: 3, runningCount: 2, pendingCount: 1 }], failures: [] }));
    });
    const ecs = await client(ECSClient);
    const out = await ecs.send(new DescribeServicesCommand({ cluster: "prod", services: ["web"] }));
    expect(out.services?.[0]).toMatchObject({ serviceName: "web", status: "ACTIVE", desiredCount: 3, runningCount: 2, pendingCount: 1 });
    expect(out.$metadata).toMatchObject({ httpStatusCode: 200, requestId: "req-ecs-1" });
    expect(service!.seen).toHaveLength(1);
    // the job the runner received is a normal, grant-bearing aws.http job
    const job = service!.seen[0];
    expect(job.claims).toMatchObject({ kind: "aws.http", capability: "infrastructure.observe", operationId: OPERATION, runnerId: agent.id });
    expect(agent.decodeJob(job.claims.grant, "zenith-grant+jwt").claims).toMatchObject({ aud: `runner:${agent.id}`, cap: "infrastructure.observe", op: OPERATION });
  });

  it("an AWS error response becomes the SDK's modelled exception, and the SDK does not retry it (one job)", async () => {
    await start(() => reply(400, { "content-type": "application/x-amz-json-1.1", "x-amzn-errortype": "ClusterNotFoundException", "x-amzn-requestid": "req-2" }, JSON.stringify({ __type: "ClusterNotFoundException", message: "Cluster not found." })));
    const ecs = await client(ECSClient);
    await expect(ecs.send(new DescribeServicesCommand({ cluster: "nope", services: ["web"] }))).rejects.toMatchObject({ name: "ClusterNotFoundException", message: "Cluster not found.", $metadata: { httpStatusCode: 400 } });
    expect(await plane.store.jobs.listForOperation("w-a", OPERATION)).toHaveLength(1);
  });

  it("a throttling or 5xx answer is NOT retried by the SDK either: one SDK call is at most one job", async () => {
    await start(() => reply(503, { "content-type": "application/x-amz-json-1.1", "x-amzn-errortype": "ServiceUnavailableException" }, JSON.stringify({ __type: "ServiceUnavailableException", message: "busy" })));
    const ecs = await client(ECSClient);
    await expect(ecs.send(new DescribeServicesCommand({ cluster: "c", services: ["w"] }))).rejects.toMatchObject({ name: "ServiceUnavailableException" });
    expect(await plane.store.jobs.listForOperation("w-a", OPERATION)).toHaveLength(1);
  });

  it("honours a region override on the client and sends it as the SigV4 region", async () => {
    await start((_job, p) => {
      expect(p).toMatchObject({ region: "eu-west-1", url: "https://ecs.eu-west-1.amazonaws.com/" });
      return reply(200, { "content-type": "application/x-amz-json-1.1" }, JSON.stringify({ services: [], failures: [] }));
    });
    const grant = await runnerGrant(plane, { runnerId: agent.id, workspaceId: "w-a", operationId: OPERATION, capability: "infrastructure.observe" });
    const factory = createRunnerAwsSessionClientFactory({ runnerId: agent.id, workspaceId: "w-a", operationId: OPERATION, grant, region: "us-east-1" });
    await factory(ECSClient, { region: "eu-west-1" }).send(new DescribeServicesCommand({ services: ["w"] }));
    expect(service!.seen).toHaveLength(1);
  });
});

describe("query protocol (STS, EC2)", () => {
  it("STS GetCallerIdentity: form body out, XML response in", async () => {
    await start((_job, p) => {
      assertUnsigned(p);
      expect(p).toMatchObject({ service: "sts", method: "POST" });
      expect(new URL(p.url).hostname).toMatch(/^sts(\.us-east-1)?\.amazonaws\.com$/);
      expect(p.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(new URLSearchParams(bodyOf(p)).get("Action")).toBe("GetCallerIdentity");
      return reply(
        200,
        { "content-type": "text/xml", "x-amzn-requestid": "req-sts-1" },
        `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:sts::111122223333:assumed-role/zenith-observe/runner</Arn><UserId>AROAEXAMPLE:runner</UserId><Account>111122223333</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>req-sts-1</RequestId></ResponseMetadata></GetCallerIdentityResponse>`
      );
    });
    const sts = await client(STSClient);
    const out = await sts.send(new GetCallerIdentityCommand({}));
    expect(out).toMatchObject({ Account: "111122223333", Arn: "arn:aws:sts::111122223333:assumed-role/zenith-observe/runner" });
    expect(out.$metadata.requestId).toBe("req-sts-1");
  });

  it("STS error: the XML <Error> element becomes a modelled exception", async () => {
    await start(() =>
      reply(403, { "content-type": "text/xml" }, `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>ExpiredToken</Code><Message>The security token included in the request is expired</Message></Error><RequestId>req-e</RequestId></ErrorResponse>`)
    );
    const sts = await client(STSClient);
    await expect(sts.send(new GetCallerIdentityCommand({}))).rejects.toMatchObject({ name: "ExpiredToken", message: "The security token included in the request is expired", $metadata: { httpStatusCode: 403 } });
  });

  it("EC2 DescribeInstances (query protocol with nested XML lists)", async () => {
    await start((_job, p) => {
      assertUnsigned(p);
      expect(p.service).toBe("ec2");
      const form = new URLSearchParams(bodyOf(p));
      expect(form.get("Action")).toBe("DescribeInstances");
      expect(form.get("InstanceId.1")).toBe("i-0abc");
      return reply(
        200,
        { "content-type": "text/xml;charset=UTF-8" },
        `<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>req-ec2</requestId><reservationSet><item><reservationId>r-1</reservationId><instancesSet><item><instanceId>i-0abc</instanceId><instanceType>t3.micro</instanceType><instanceState><code>16</code><name>running</name></instanceState></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`
      );
    });
    const ec2 = await client(EC2Client);
    const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: ["i-0abc"] }));
    expect(out.Reservations?.[0].Instances?.[0]).toMatchObject({ InstanceId: "i-0abc", InstanceType: "t3.micro", State: { Name: "running", Code: 16 } });
  });
});

describe("REST protocols (S3 REST-XML, Lambda REST-JSON, Route 53)", () => {
  it("S3 HeadBucket: HEAD to the virtual-hosted endpoint; status and headers come back, no body", async () => {
    await start((_job, p) => {
      assertUnsigned(p);
      expect(p).toMatchObject({ service: "s3", method: "HEAD", url: "https://my-bucket.s3.us-east-1.amazonaws.com/" });
      return reply(200, { "x-amz-bucket-region": "us-east-1", "x-amz-access-point-alias": "false", "x-amz-request-id": "req-s3" });
    });
    const s3 = await client(S3Client);
    const out = await s3.send(new HeadBucketCommand({ Bucket: "my-bucket" }));
    expect(out).toMatchObject({ BucketRegion: "us-east-1" });
    expect(out.$metadata.httpStatusCode).toBe(200);
  });

  it("S3 HeadBucket on a missing bucket is the SDK's NotFound", async () => {
    await start(() => reply(404, { "x-amz-request-id": "req-404" }));
    const s3 = await client(S3Client);
    await expect(s3.send(new HeadBucketCommand({ Bucket: "gone" }))).rejects.toMatchObject({ name: "NotFound", $metadata: { httpStatusCode: 404 } });
  });

  it("S3 PutObject sends the exact body bytes (binary-safe) and GetObject streams the body back", async () => {
    const stored = new Map<string, Buffer>();
    await start((_job, p) => {
      assertUnsigned(p);
      const url = new URL(p.url);
      if (p.method === "PUT") {
        stored.set(url.pathname, Buffer.from(p.bodyB64 ?? "", "base64"));
        return reply(200, { etag: '"abc123"', "x-amz-request-id": "req-put" });
      }
      const body = stored.get(url.pathname) ?? Buffer.alloc(0);
      return reply(200, { "content-type": "application/octet-stream", "content-length": String(body.length), etag: '"abc123"' }, body);
    });
    const s3 = await client(S3Client);
    const bytes = Buffer.from([0, 1, 2, 254, 255, 0, 128, 10, 13]);
    const put = await s3.send(new PutObjectCommand({ Bucket: "zenith-test", Key: "dir/obj.bin", Body: bytes }));
    expect(put.ETag).toBe('"abc123"');
    expect(stored.get("/dir/obj.bin")).toEqual(bytes);
    const got = await s3.send(new GetObjectCommand({ Bucket: "zenith-test", Key: "dir/obj.bin" }));
    expect(Buffer.from(await got.Body!.transformToByteArray())).toEqual(bytes);
  });

  it("Lambda ListFunctions (REST-JSON): path and query string arrive as serialized", async () => {
    await start((_job, p) => {
      assertUnsigned(p);
      const url = new URL(p.url);
      expect(p).toMatchObject({ service: "lambda", method: "GET" });
      expect(url.pathname).toBe("/2015-03-31/functions");
      expect(url.searchParams.get("MaxItems")).toBe("5");
      expect(url.searchParams.get("Marker")).toBe("a b&c=d");
      return reply(200, { "content-type": "application/json" }, JSON.stringify({ Functions: [{ FunctionName: "api", Runtime: "nodejs22.x", MemorySize: 256 }], NextMarker: null }));
    });
    const lambda = await client(LambdaClient);
    const out = await lambda.send(new ListFunctionsCommand({ MaxItems: 5, Marker: "a b&c=d" }));
    expect(out.Functions).toEqual([expect.objectContaining({ FunctionName: "api", Runtime: "nodejs22.x", MemorySize: 256 })]);
  });

  it("a global service signs as us-east-1 whatever the client region (Route 53), because the SDK's own signing region travels with the job", async () => {
    await start((_job, p) => {
      expect(p).toMatchObject({ service: "route53", region: "us-east-1", method: "GET", url: "https://route53.amazonaws.com/2013-04-01/hostedzone" });
      return reply(200, { "content-type": "text/xml" }, `<ListHostedZonesResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><HostedZones><HostedZone><Id>/hostedzone/Z1</Id><Name>example.com.</Name><CallerReference>x</CallerReference></HostedZone></HostedZones><IsTruncated>false</IsTruncated><MaxItems>100</MaxItems></ListHostedZonesResponse>`);
    });
    const r53 = await client(Route53Client, "ap-south-1");
    const out = await r53.send(new ListHostedZonesCommand({}));
    expect(out.HostedZones?.[0]).toMatchObject({ Id: "/hostedzone/Z1", Name: "example.com." });
  });
});

describe("failure mapping", () => {
  it("a runner that rejects the job (not allowed) surfaces as RunnerJobError, not as an AWS error, and is not uncertain", async () => {
    await start(() => ({ status: "rejected", error: "not_allowed: ecs:DescribeServices is not allowed for capability \"infrastructure.observe\" on this runner", result: { reason: "not_allowed" } }));
    const ecs = await client(ECSClient);
    const err = await ecs.send(new DescribeServicesCommand({ services: ["w"] })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerJobError);
    expect(err).toMatchObject({ code: "runner_job_rejected", uncertain: false });
    expect(String((err as Error).message)).toContain("not_allowed");
  });

  it("a runner-side failure is runner_job_failed; a runner timeout is UNCERTAIN", async () => {
    let n = 0;
    await start(() => (++n === 1 ? { status: "failed", error: "aws_credentials_unavailable: no credentials found" } : { status: "timed_out", error: "the job exceeded its 30s timeout" }));
    const ecs = await client(ECSClient);
    const first = await ecs.send(new DescribeServicesCommand({ services: ["w"] })).catch((e: unknown) => e);
    expect(first).toMatchObject({ code: "runner_job_failed", uncertain: false });
    const second = await ecs.send(new DescribeServicesCommand({ services: ["w"] })).catch((e: unknown) => e);
    expect(second).toMatchObject({ code: "runner_job_uncertain", uncertain: true });
  });

  it("refuses to use a client after its session ended, without creating a job", async () => {
    let active = true;
    const ecs = await client(ECSClient, "us-east-1", { isActive: () => active });
    active = false;
    await expect(ecs.send(new DescribeServicesCommand({ services: ["w"] }))).rejects.toBeInstanceOf(RunnerTransportError);
    expect(await plane.store.jobs.listForOperation("w-a", OPERATION)).toEqual([]);
  });

  it("refuses a request whose job the control plane would not sign (a grant for another operation)", async () => {
    const wrong = await runnerGrant(plane, { runnerId: agent.id, workspaceId: "w-a", operationId: "op_other", capability: "infrastructure.observe" });
    const ecs = await client(ECSClient, "us-east-1", { grant: wrong });
    await expect(ecs.send(new DescribeServicesCommand({ services: ["w"] }))).rejects.toMatchObject({ code: "grant_invalid" });
    expect(await plane.store.jobs.listForOperation("w-a", OPERATION)).toEqual([]);
  });

  it("an aborted SDK call stops waiting and cancels a job that was never claimed", async () => {
    const ac = new AbortController();
    const ecs = await client(ECSClient); // no runner service is running: the job stays queued
    const pending = ecs.send(new DescribeServicesCommand({ services: ["w"] }), { abortSignal: ac.signal });
    await new Promise((r) => setTimeout(r, 60));
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const [job] = await plane.store.jobs.listForOperation("w-a", OPERATION);
    expect(job.status).toBe("cancelled");
  });
});

describe("the credential broker's runner transport (RunnerAwsTransportFactory)", () => {
  const config: AwsConnectionConfig = {
    provider: "aws", mode: "runner", accountId: "111122223333", region: "us-east-1", runnerId: "",
    observeRoleArn: "arn:aws:iam::111122223333:role/x", deployRoleArn: "arn:aws:iam::111122223333:role/x",
    runnerCustody: "local_only",
  };
  let bindingDb: DbPlane | undefined;
  afterEach(async () => {
    await bindingDb?.close();
    bindingDb = undefined;
  });

  /** Real repository lifecycle on PGlite; runner and AWS replies remain modeled. */
  async function verifiedRunnerConnection(): Promise<ProviderConnection> {
    bindingDb = await openDbPlane();
    const db = bindingDb.db;
    const pending = await repos.connections.create(db, {
      id: "conn_1", workspaceId: "w-a", createdBy: "runner-transport-fixture", config: { ...config, runnerId: agent.id },
    });
    expect(pending.status).toBe("pending_verification");
    const verified = await repos.connections.recordVerification(db, { workspaceId: "w-a", id: pending.id, ok: true, detail: "modeled runner verification" });
    expect(verified).toMatchObject({ id: pending.id, workspaceId: "w-a", status: "verified", config: { mode: "runner", runnerId: agent.id, runnerCustody: "local_only" } });
    if (!verified) throw new Error("The scoped runner connection fixture was not verified.");
    plane.rt.connections = (workspaceId, id) => repos.connections.get(db, workspaceId, id);
    expect(await plane.rt.connections("w-b", verified.id)).toBeNull();
    return verified;
  }

  async function workerGrant() {
    const iat = Math.floor(plane.rt.now() / 1000);
    return { jti: "grt_worker", iss: "zenith-control-plane", aud: "worker", sub: "user_1", iat, exp: iat + 900, cap: "infrastructure.observe", op: OPERATION, digest: "sha256:x", ws: "w-a", env: "env_1" };
  }

  it("re-addresses the worker's grant to the runner (same scope, new id, never wider) and serves SDK clients", async () => {
    const connection = await verifiedRunnerConnection();
    const grant = await workerGrant();
    const transport = await createRunnerAwsTransportFactory({ runtime: plane.rt }).open({ connection, config: { ...config, runnerId: agent.id }, grant, purpose: "observe", roleArn: "arn:aws:iam::111122223333:role/x", expiresAt: new Date(plane.rt.now() + 5 * 60_000) });
    await start((job, p) => {
      assertUnsigned(p);
      const g = agent.decodeJob(job.claims.grant, "zenith-grant+jwt").claims;
      expect(g).toMatchObject({ aud: `runner:${agent.id}`, cap: "infrastructure.observe", op: OPERATION, ws: "w-a", env: "env_1", sub: "user_1", digest: "sha256:x" });
      expect(g.jti).not.toBe("grt_worker");
      expect(Number(g.exp)).toBeLessThanOrEqual(grant.exp);
      return reply(200, { "content-type": "application/x-amz-json-1.1" }, JSON.stringify({ services: [], failures: [] }));
    });
    await transport.client(ECSClient).send(new DescribeServicesCommand({ services: ["w"] }));
    expect(service!.seen).toHaveLength(1);
    // the re-addressed grant is a real grant: the credential module's own verifier accepts it for the runner
    const verified = await verifyCapabilityGrant(service!.seen[0].claims.grant, { audience: `runner:${agent.id}`, expectedCapability: "infrastructure.observe", expectedOperationId: OPERATION, keys: await plane.rt.verificationKeys(), now: new Date(plane.rt.now()) });
    expect(verified.ws).toBe("w-a");
    // closing the transport ends the session for every client built from it
    await transport.close?.();
    await expect(transport.client(ECSClient).send(new DescribeServicesCommand({ services: ["w"] }))).rejects.toBeInstanceOf(RunnerTransportError);
  });

  it("clamps the runner grant to the session's expiry across a wall-clock second boundary and refuses a connection that names no runner", async () => {
    const connection = await verifiedRunnerConnection();
    const grant = await workerGrant();
    const expiresAt = new Date(plane.rt.now() + 60_000);
    await start((job) => {
      const g = agent.decodeJob(job.claims.grant, "zenith-grant+jwt").claims;
      expect(Number(g.exp)).toBe(Math.floor(expiresAt.getTime() / 1000));
      return reply(200, { "content-type": "application/x-amz-json-1.1" }, JSON.stringify({ services: [], failures: [] }));
    });
    const factory = createRunnerAwsTransportFactory({ runtime: plane.rt });
    const short = await factory.open({ connection, config: { ...config, runnerId: agent.id }, grant, purpose: "observe", roleArn: "arn:aws:iam::111122223333:role/x", expiresAt });
    const openedAt = plane.rt.now();
    // Polling and SDK serialization can cross a second after the session opens.
    // Its signed expiry must still equal the original session deadline exactly.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(Math.floor(plane.rt.now() / 1000)).toBeGreaterThan(Math.floor(openedAt / 1000));
    await short.client(ECSClient).send(new DescribeServicesCommand({ services: ["w"] }));
    await expect(factory.open({ connection, config, grant, purpose: "observe", roleArn: "arn:aws:iam::111122223333:role/x", expiresAt })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
