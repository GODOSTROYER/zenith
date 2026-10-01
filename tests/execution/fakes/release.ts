/**
 * Scripted release-side ports: prober, source bundler, builder, workload
 * deployer and one-off task runner. They record what they were asked and answer
 * what the test scripted. NOT CodeBuild or ECS.
 */
import type { DriverContext } from "@/lib/drivers/types";
import type { BuildHandle, BuildPort, BuildResult, MigrationsPort, ProberPort, ProbeRequest, ProbeResult, SourceBundlePort, WorkloadsPort } from "@/lib/execution/ports";
import type { ResourceNode } from "@/lib/resources/types";

export class FakeProber implements ProberPort {
  readonly calls: ProbeRequest[] = [];
  /** per host: a result, or a sequence consumed one per call (the last repeats) */
  responses = new Map<string, ProbeResult | ProbeResult[]>();
  default: (req: ProbeRequest) => ProbeResult = (req) => ({
    host: req.host,
    path: req.path,
    outcome: "responded",
    status: 200,
    latencyMs: 12,
    bytes: 2,
    bodyDigest: "e".repeat(64),
    tlsExpiresAt: "2027-01-01T00:00:00.000Z",
    address: "93.184.216.34",
  });
  async probe(req: ProbeRequest): Promise<ProbeResult> {
    this.calls.push(req);
    const scripted = this.responses.get(req.host);
    if (Array.isArray(scripted)) {
      const n = this.calls.filter((c) => c.host === req.host).length;
      return scripted[Math.min(n, scripted.length) - 1];
    }
    return scripted ?? this.default(req);
  }
}

export class FakeSourceBundle implements SourceBundlePort {
  readonly calls: { service: string; repo: string; ref: string; hadSession: boolean }[] = [];
  async prepare(ctx: DriverContext, input: { service: ResourceNode; source: { repo: string; ref: string; dockerfile?: string } }): Promise<{ s3Key: string; digest: string; bucket?: string }> {
    this.calls.push({ service: input.service.address, repo: input.source.repo, ref: input.source.ref, hadSession: ctx.session !== undefined });
    return { s3Key: `bundles/${input.service.address.replace("/", "-")}.tgz`, digest: "5".repeat(64), bucket: "zenith-artifacts" };
  }
}

export class FakeBuild implements BuildPort {
  readonly started: { service: string; pipeline: string; registry?: string; idempotencyKey: string; fence?: number }[] = [];
  result: BuildResult = { status: "succeeded", imageUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/zenith-api:latest", digest: `sha256:${"9".repeat(64)}` };
  async startBuild(ctx: DriverContext, input: { service: ResourceNode; pipeline: ResourceNode; registry?: ResourceNode; source: { s3Key: string; digest: string }; idempotencyKey: string }): Promise<BuildHandle> {
    this.started.push({
      service: input.service.address,
      pipeline: input.pipeline.address,
      ...(input.registry ? { registry: input.registry.address } : {}),
      idempotencyKey: input.idempotencyKey,
      ...(ctx.fence ? { fence: ctx.fence.token } : {}),
    });
    return { buildId: `zenith-${input.service.address.replace("/", "-")}:build-1` };
  }
  async waitForBuild(): Promise<BuildResult> {
    return this.result;
  }
}

export class FakeWorkloads implements WorkloadsPort {
  readonly deployed: { service: string; uri: string; digest: string; idempotencyKey: string }[] = [];
  readonly waited: string[] = [];
  steady = true;
  /** `waitSteady` waits for this before answering (the test holds it) */
  waitGate: Promise<void> | undefined;
  async deployImage(_ctx: DriverContext, service: ResourceNode, image: { uri: string; digest: string }, opts: { idempotencyKey: string }): Promise<{ detail?: string }> {
    this.deployed.push({ service: service.address, uri: image.uri, digest: image.digest, idempotencyKey: opts.idempotencyKey });
    return {};
  }
  async waitSteady(_ctx: DriverContext, service: ResourceNode): Promise<{ steady: boolean; detail?: string }> {
    this.waited.push(service.address);
    if (this.waitGate) await this.waitGate;
    return this.steady ? { steady: true } : { steady: false, detail: "2 of 3 tasks running" };
  }
}

export class FakeMigrations implements MigrationsPort {
  readonly runs: { service: string; command: readonly string[]; timeoutMs: number; idempotencyKey: string }[] = [];
  exitCode = 0;
  error: Error | undefined;
  async runOneOffTask(_ctx: DriverContext, service: ResourceNode, command: readonly string[], opts: { timeoutMs: number; idempotencyKey: string }): Promise<{ exitCode: number; logsRef?: string }> {
    this.runs.push({ service: service.address, command, timeoutMs: opts.timeoutMs, idempotencyKey: opts.idempotencyKey });
    if (this.error) throw this.error;
    return { exitCode: this.exitCode, logsRef: "logs/migrate/1" };
  }
}
