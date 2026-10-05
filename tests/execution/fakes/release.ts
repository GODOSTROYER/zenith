/**
 * Scripted release-side ports: prober, source bundler, builder, workload
 * deployer and one-off task runner. They record what they were asked and answer
 * what the test scripted. NOT CodeBuild or ECS.
 */
import { immutableSourceSnapshot, type ApprovedSourceSnapshot, type SourceCaptureInput } from "@/lib/execution/source-snapshot";
import type { DriverContext } from "@/lib/drivers/types";
import type { BuildHandle, BuildPort, BuildResult, MigrationsPort, ProgressiveWorkloadsPort, ProberPort, ProbeRequest, ProbeResult, SourceBundlePort, WorkloadsPort } from "@/lib/execution/ports";
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
  readonly captures: SourceCaptureInput[]=[];
  commit="a".repeat(40); archiveDigest="5".repeat(64); unavailable=false;
  private guard(){if(process.env.NODE_ENV!=="test")throw new Error("Isolated source model requires test mode.");}
  constructor(){this.guard();}
  async capture(input:SourceCaptureInput):Promise<ApprovedSourceSnapshot>{
    this.guard();this.captures.push(input);const match=/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(input.repository);if(!match)throw new Error("Isolated source repository is invalid.");
    const {repository:_repository,...rest}=input;void _repository;
    return immutableSourceSnapshot({...rest,format:"zenith.approved-source.v1",owner:match[1].toLowerCase(),repo:match[2].toLowerCase(),repositoryId:101,commitSha:this.commit,githubBinding:null,dockerfileDigest:"d".repeat(64),archiveDigest:this.archiveDigest,archiveBytes:100});
  }
  async verify(snapshot:ApprovedSourceSnapshot):Promise<void>{this.guard();if(this.unavailable || snapshot.archiveDigest!==this.archiveDigest)throw new Error("Isolated source verification refused.");}
  async prepare(ctx: DriverContext, input: { service: ResourceNode; source: { repo: string; ref: string; dockerfile?: string }; approvedSource?: ApprovedSourceSnapshot }): Promise<{ s3Key: string; digest: string; bucket?: string }> {
    this.guard();if(!input.approvedSource)throw new Error("Isolated source snapshot missing.");await this.verify(input.approvedSource);
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

/** Weighted-traffic fake: records every call; `supported` scripts the capability. */
export class FakeProgressive implements ProgressiveWorkloadsPort {
  readonly calls: string[] = [];
  supported = true;
  async support(): Promise<{ supported: boolean; reason?: string }> {
    return this.supported ? { supported: true } : { supported: false, reason: "this fake has no weighted traffic" };
  }
  async stageCandidate(_ctx: DriverContext, service: ResourceNode, image: { uri: string; digest: string }): Promise<{ detail?: string }> {
    this.calls.push(`stage ${service.address} ${image.digest.slice(0, 12)}`);
    return {};
  }
  async setTrafficPercent(_ctx: DriverContext, service: ResourceNode, input: { candidateDigest: string; percent: number }): Promise<{ observedPercent: number }> {
    this.calls.push(`traffic ${service.address} ${input.percent}`);
    return { observedPercent: input.percent };
  }
  async abort(_ctx: DriverContext, service: ResourceNode): Promise<{ detail?: string }> {
    this.calls.push(`abort ${service.address}`);
    return {};
  }
}

export class FakeWorkloads implements WorkloadsPort {
  /** what `readServing` reports; `undefined` reports the adapter as unable to read it */
  serving: { digest?: string; steady?: boolean } | undefined;
  progressive: FakeProgressive | undefined;
  async readServing(): Promise<{ supported: boolean; digest?: string; steady?: boolean; detail?: string }> {
    return this.serving ? { supported: true, ...this.serving } : { supported: false };
  }
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
