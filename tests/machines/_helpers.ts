/** Shared fixtures for the machine-plane tests. */
import type { CapabilityGrantClaims, EvidenceRecord } from "@/lib/controlplane/types";
import type { AwsClientCtor, AwsSession } from "@/lib/credentials/types";
import type {
  KubernetesMachineSession,
  MachineDriver,
  MachineEvidenceInput,
  MachineEvidenceSink,
  MachineOperation,
  MachineRequest,
  MachineResult,
  MachineSessionProvider,
  MachineTransport,
} from "@/lib/machines";

export const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);
export const INSTANCE = "i-0123456789abcdef0";

export function requestFor(operation: MachineOperation, args: Record<string, unknown> = {}, over: Partial<MachineRequest> & { transport?: MachineTransport; targetId?: string } = {}): MachineRequest {
  const { transport = "aws_ssm", targetId = INSTANCE, ...rest } = over;
  return {
    operationId: "op-1",
    target: { workspaceId: "ws-1", environmentId: "env-1", resourceId: "res-1", address: "compute_instance/web", transport, targetId },
    operation,
    args,
    timeoutSec: 30,
    maxOutputBytes: 65536,
    ...rest,
  };
}

export function grantFor(operation: MachineOperation, over: Partial<CapabilityGrantClaims> = {}): CapabilityGrantClaims {
  return {
    jti: "grant-1",
    iss: "zenith",
    aud: "worker",
    sub: "user:1",
    iat: Math.floor(T0 / 1000) - 10,
    exp: Math.floor(T0 / 1000) + 300,
    cap: operation,
    op: "op-1",
    digest: "d".repeat(64),
    ws: "ws-1",
    env: "env-1",
    res: "res-1",
    ...over,
  };
}

export class MemoryEvidence implements MachineEvidenceSink {
  records: (MachineEvidenceInput & { id: string })[] = [];
  failWith?: Error;
  async record(input: MachineEvidenceInput): Promise<EvidenceRecord> {
    if (this.failWith) throw this.failWith;
    const id = `ev-${this.records.length + 1}`;
    this.records.push({ ...input, id });
    const { blob: _blob, ...rest } = input;
    return { ...rest, id, createdAt: new Date(T0).toISOString() };
  }
}

/** a session provider that hands `session` straight through and notes each scope it opens */
export function sessions(session: unknown = undefined): MachineSessionProvider & { opened: number } {
  const p = {
    opened: 0,
    async withSession<T>(_req: unknown, fn: (s: unknown) => Promise<T>): Promise<T> {
      p.opened++;
      return fn(session);
    },
  };
  return p;
}

export function awsSession(): AwsSession {
  return {
    provider: "aws",
    accountId: "123456789012",
    region: "ap-south-1",
    expiresAt: new Date(T0 + 900_000).toISOString(),
    transport: "direct",
    client<C>(ctor: AwsClientCtor<C>): C {
      return new ctor({ region: "ap-south-1", credentials: { accessKeyId: "AKIATESTONLY", secretAccessKey: "test-only" } });
    },
    childProcessEnv: () => ({}),
  };
}

export function k8sSession(namespaces: string[], kubeConfig: unknown = {}): KubernetesMachineSession {
  return { provider: "kubernetes", server: "https://k8s.test", expiresAt: new Date(T0 + 900_000).toISOString(), kubeConfig: () => kubeConfig, namespaces };
}

/** a fake clock whose sleep advances time instead of waiting */
export function fakeClock(start = T0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export function okResult(req: MachineRequest, driver: Pick<MachineDriver, "transport">, data: Record<string, unknown> = {}, extra: Partial<MachineResult> = {}): MachineResult {
  return { ok: true, operation: req.operation, data, startedAt: new Date(T0).toISOString(), finishedAt: new Date(T0 + 5).toISOString(), transport: driver.transport, simulated: false, ...extra };
}
