/**
 * Payload schemas for every runner job kind (RUNNER-PROTOCOL.md section 4) and
 * the zenithd operation vocabulary (section 5).
 *
 * The Go runner decodes each payload strictly (unknown members are refused),
 * so these schemas are `.strict()` too: a job the control plane would send is
 * a job the agent will accept structurally, and a typo fails here, before a
 * signed envelope exists, instead of as a `rejected` result after a round trip.
 * They validate SHAPE and bounds. Policy (which hosts, which actions) is the
 * agent's local allowlist and cannot be overridden from here.
 *
 * `destroy` on `tofu.run` is an extension the Go agent accepts (plan only); the
 * spec's payload table does not list it.
 */
import { z } from "zod";
import { isSafeRelativePath } from "@/lib/tofu/config-digest";
import { MACHINE_OPERATIONS, type MachineOperation } from "@/lib/machines/types";
import type { RunnerJobKind } from "@/lib/runners/types";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");
/** Strict standard base64 (padded); what `Buffer.from(x, "base64").toString("base64")` round-trips. */
const base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "must be standard base64");
const headerValue = z.union([z.string().max(8192), z.array(z.string().max(8192)).max(32)]);

export const MAX_TOFU_FILES = 512;

export const TofuRunPayloadSchema = z
  .object({
    command: z.enum(["plan", "apply", "show"]),
    files: z
      .array(z.object({ path: z.string().refine(isSafeRelativePath, "unsafe workspace path"), contentB64: base64 }).strict())
      .min(1)
      .max(MAX_TOFU_FILES),
    lockfile: z.string().max(1 << 20),
    configDigest: hex64,
    planFileSha256: hex64.optional(),
    destroy: z.boolean().optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.command === "plan" && p.planFileSha256 !== undefined) ctx.addIssue({ code: "custom", path: ["planFileSha256"], message: "planFileSha256 is only valid with apply and show" });
    if (p.command !== "plan" && p.planFileSha256 === undefined) ctx.addIssue({ code: "custom", path: ["planFileSha256"], message: `${p.command} requires planFileSha256` });
    if (p.destroy && p.command !== "plan") ctx.addIssue({ code: "custom", path: ["destroy"], message: "destroy is only valid with plan" });
    const seen = new Set<string>();
    for (const f of p.files) {
      if (seen.has(f.path)) ctx.addIssue({ code: "custom", path: ["files"], message: `duplicate file path ${f.path}` });
      seen.add(f.path);
    }
    for (const a of seen) for (const b of seen) if (a !== b && b.startsWith(`${a}/`)) ctx.addIssue({ code: "custom", path: ["files"], message: `${a} is both a file and a directory` });
  });

export const AwsHttpPayloadSchema = z
  .object({
    service: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    region: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"]),
    url: z
      .string()
      .max(8192)
      .refine((u) => u.startsWith("https://"), "aws.http requires an https:// URL"),
    headers: z.record(headerValue).default({}),
    bodyB64: base64.optional(),
  })
  .strict();

export const K8sHttpPayloadSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().min(1).max(4096).startsWith("/"),
    bodyB64: base64.optional(),
    contentType: z.string().max(128).optional(),
  })
  .strict();

const timeoutMs = z.number().int().min(1).max(120_000);

export const ProbeHttpPayloadSchema = z
  .object({
    url: z.string().min(1).max(8192),
    method: z.enum(["GET", "HEAD"]).optional(),
    headers: z.record(z.string().max(8192)).optional(),
    timeoutMs: timeoutMs.optional(),
    followRedirects: z.boolean().optional(),
    maxRedirects: z.number().int().min(0).max(10).optional(),
    expectStatus: z.array(z.number().int().min(100).max(599)).max(32).optional(),
    includeBody: z.boolean().optional(),
    maxBodyBytes: z.number().int().min(1).max(1 << 20).optional(),
  })
  .strict();

export const ProbeTcpPayloadSchema = z.object({ host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535), timeoutMs: timeoutMs.optional() }).strict();

export const ProbeDnsPayloadSchema = z.object({ name: z.string().min(1).max(253), type: z.string().min(1).max(16).optional(), timeoutMs: timeoutMs.optional() }).strict();

export const RUNNER_PAYLOAD_SCHEMAS: { [K in RunnerJobKind]: z.ZodType<unknown> } = {
  "tofu.run": TofuRunPayloadSchema,
  "aws.http": AwsHttpPayloadSchema,
  "k8s.http": K8sHttpPayloadSchema,
  "probe.http": ProbeHttpPayloadSchema,
  "probe.tcp": ProbeTcpPayloadSchema,
  "probe.dns": ProbeDnsPayloadSchema,
};

export type TofuRunPayload = z.infer<typeof TofuRunPayloadSchema>;
export type AwsHttpPayload = z.infer<typeof AwsHttpPayloadSchema>;

export class PayloadError extends Error {
  readonly code = "invalid_payload";
  constructor(
    readonly kind: string,
    detail: string
  ) {
    super(`The ${kind} payload is invalid: ${detail}`);
    this.name = "PayloadError";
  }
}

/** Validate and normalize a payload for `kind`; the returned value is what gets signed. */
export function validateRunnerPayload(kind: RunnerJobKind, payload: unknown): unknown {
  const schema = RUNNER_PAYLOAD_SCHEMAS[kind];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PayloadError(kind, `${issue.path.join(".") || "payload"}: ${issue.message}`);
  }
  return parsed.data;
}

/* ------------------------------- zenithd (machine) ------------------------------- */

/**
 * Operations zenithd implements. `file.write`, `file.upload` and
 * `package.install` exist in the platform vocabulary but zenithd deliberately
 * does not implement them (the Go agent refuses them), so they are never dispatched.
 */
export const ZENITHD_OPERATIONS: readonly MachineOperation[] = MACHINE_OPERATIONS.filter((op) => op !== "file.write" && op !== "file.upload" && op !== "package.install");

export const MAX_MACHINE_ARGS_BYTES = 64 * 1024;

/**
 * Generic argument checks. Per-operation argument schemas belong to the
 * machines module (`MachineArgsSchemas`); zenithd validates them again locally
 * and never builds a shell string from them.
 */
export function validateMachineArgs(operation: string, args: unknown): Record<string, unknown> {
  if (!(ZENITHD_OPERATIONS as readonly string[]).includes(operation)) throw new PayloadError(operation, "zenithd does not implement this operation");
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new PayloadError(operation, "args must be a JSON object");
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(args), "utf8");
  } catch {
    throw new PayloadError(operation, "args must be JSON-serializable");
  }
  if (size > MAX_MACHINE_ARGS_BYTES) throw new PayloadError(operation, `args are larger than ${MAX_MACHINE_ARGS_BYTES} bytes`);
  return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
}
