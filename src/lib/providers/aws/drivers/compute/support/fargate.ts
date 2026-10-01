/**
 * Fargate task sizing.
 *
 * A manifest asks for `vcpu` and `memoryMb` in portable terms (`nano` is 0.25
 * vCPU / 256 MB). Fargate only runs a fixed set of cpu/memory pairs, and the
 * portable sizes are mostly NOT on it (256 MB at 0.25 vCPU does not exist;
 * the smallest 0.25 vCPU task has 512 MB). The rule is "round UP to the
 * nearest valid combination, never down": the smallest cpu tier that is at
 * least the requested vCPU and whose memory range can hold the requested
 * memory, with memory raised to that tier's minimum / next allowed step.
 * The rounding is reported (`rounded`, `note`) so the plan UI can say so, and
 * `expectedAttributes` uses the rounded values so drift compares like with like.
 *
 * Table source: the Amazon ECS developer guide ("Troubleshoot ... invalid CPU
 * or memory errors", Linux column), read on 2026-09-30. The 32 vCPU tier the
 * guide also lists (60/120/244 GB) is deliberately left out: nothing in the
 * portable sizes asks for it. A live RegisterTaskDefinition is the only ground
 * truth and has not been run (no AWS account); evidence stays `contract`.
 */
import { ComputeCompileError } from "./tf";

interface Tier {
  cpu: number; // CPU units (1024 = 1 vCPU)
  minMb: number;
  maxMb: number;
  stepMb: number;
}

export const FARGATE_TIERS: readonly Tier[] = [
  { cpu: 256, minMb: 512, maxMb: 2048, stepMb: 512 }, // 0.25 vCPU: 512 MB, 1 GB, 2 GB
  { cpu: 512, minMb: 1024, maxMb: 4096, stepMb: 1024 },
  { cpu: 1024, minMb: 2048, maxMb: 8192, stepMb: 1024 },
  { cpu: 2048, minMb: 4096, maxMb: 16384, stepMb: 1024 },
  { cpu: 4096, minMb: 8192, maxMb: 30720, stepMb: 1024 },
  { cpu: 8192, minMb: 16384, maxMb: 61440, stepMb: 4096 },
  { cpu: 16384, minMb: 32768, maxMb: 122880, stepMb: 8192 },
];

export interface FargateSize {
  /** CPU units, e.g. 256 */
  cpu: number;
  memoryMb: number;
  /** true when the requested size was not itself a valid Fargate combination */
  rounded: boolean;
  requested: { vcpu: number; memoryMb: number };
  note?: string;
}

export function fargateSize(vcpu: unknown, memoryMb: unknown): FargateSize {
  if (typeof vcpu !== "number" || !Number.isFinite(vcpu) || vcpu <= 0) throw new ComputeCompileError("invalid_spec", `vcpu must be a positive number (got ${String(vcpu)}).`);
  if (typeof memoryMb !== "number" || !Number.isFinite(memoryMb) || memoryMb <= 0) throw new ComputeCompileError("invalid_spec", `memoryMb must be a positive number (got ${String(memoryMb)}).`);
  const wantCpu = Math.ceil(vcpu * 1024);
  for (const t of FARGATE_TIERS) {
    if (t.cpu < wantCpu) continue;
    const base = Math.max(memoryMb, t.minMb);
    const stepped = t.minMb + Math.ceil((base - t.minMb) / t.stepMb) * t.stepMb;
    if (stepped > t.maxMb) continue; // this tier cannot hold the memory; try the next cpu tier
    const rounded = t.cpu !== wantCpu || stepped !== memoryMb;
    return {
      cpu: t.cpu,
      memoryMb: stepped,
      rounded,
      requested: { vcpu, memoryMb },
      ...(rounded ? { note: `Requested ${vcpu} vCPU / ${memoryMb} MB is not a Fargate size; using ${t.cpu} CPU units / ${stepped} MB (rounded up).` } : {}),
    };
  }
  throw new ComputeCompileError("unsupported", `No Fargate task size fits ${vcpu} vCPU / ${memoryMb} MB (maximum is 16 vCPU / 120 GB).`);
}
