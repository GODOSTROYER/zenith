/** PROD-DUR-05: sanitized PlanView and raw custody material stay separate at every model-visible surface. Fixtures built at run time. */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertPlanViewOnly, containsRawPlanMaterial, isRawPlanRecord, isRawPlanString, RawPlanMaterialError } from "@/lib/security/raw-plan-material";
import { detectCredentialShapes, sanitizeForModel } from "@/lib/security/result-sanitizer";
import { buildEnvelope } from "@/lib/agent-access/v3/envelope";
import { projectPlanReview } from "@/lib/controlplane/db/repos/operation-review";

const hash = (label: string): string => createHash("sha256").update(label).digest("hex");
const DIGEST_A = hash("a"), DIGEST_B = hash("b"), DIGEST_C = hash("c");
/** A zip-container-looking base64 plan, produced at run time. */
const planBase64 = (): string => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(300)]).toString("base64");
const sealed = () => ({ iv: randomBytes(12).toString("base64"), authTag: randomBytes(16).toString("base64"), ciphertext: randomBytes(64).toString("base64") });
const view = (planDigest: string) => ({
  planDigest, tofuVersion: "1.12.5", empty: false, summary: { create: 1, update: 0, delete: 0, replace: 0, noop: 0 },
  resources: [{ address: "aws_s3_bucket.a", type: "aws_s3_bucket", action: "create", destroysData: false, changes: [{ path: "bucket", forcesReplacement: false }], omittedChanges: 0 }],
  outputs: [], diagnostics: [], truncated: false, untrustedValues: true as const,
});
const facts = { create: 1, update: 0, delete: 0, replace: 0, destroysData: false, destroyedStatefulAddresses: [], regions: ["us-east-1"], publicDatabases: [], openIngress: [],
  wildcardIam: [], identityChanges: [], firewallChanges: [], dnsChanges: [] };

describe("raw plan material detection", () => {
  it("recognizes sealed custody records, plan byte carriers and the custody manifest shape", () => {
    expect(isRawPlanRecord(sealed())).toBe(true);
    expect(isRawPlanRecord({ planFile: "x" })).toBe(true);
    expect(isRawPlanRecord({ rawSha256: "a".repeat(64), bytes: 10 })).toBe(true);
    expect(isRawPlanRecord({ ciphertext: "x" })).toBe(false);
    expect(isRawPlanRecord({ summary: { create: 1 } })).toBe(false);
    expect(isRawPlanString(planBase64())).toBe(true);
    expect(isRawPlanString("UEsDB")).toBe(false);
  });
  it("assertPlanViewOnly fails closed on records and binary, and on plan strings only when asked", () => {
    expect(() => assertPlanViewOnly(view(DIGEST_A))).not.toThrow();
    expect(() => assertPlanViewOnly({ view: view(DIGEST_A), custody: { sealed: sealed() } })).toThrow(RawPlanMaterialError);
    expect(() => assertPlanViewOnly({ a: { b: [sealed()] } })).toThrow(RawPlanMaterialError);
    expect(() => assertPlanViewOnly({ planBytes: "x" })).toThrow(RawPlanMaterialError);
    expect(() => assertPlanViewOnly({ blob: Buffer.from("x") })).toThrow(RawPlanMaterialError);
    const plan = planBase64();
    expect(() => assertPlanViewOnly({ value: plan })).not.toThrow();
    expect(() => assertPlanViewOnly({ value: plan }, { strings: true })).toThrow(RawPlanMaterialError);
    expect(containsRawPlanMaterial({ value: plan }, true)).toBe(true);
  });
  it("the error never echoes a value", () => {
    const plan = planBase64();
    try { assertPlanViewOnly({ x: plan }, { strings: true }); } catch (error) { expect(String((error as Error).message)).not.toContain(plan.slice(0, 40)); return; }
    throw new Error("expected a refusal");
  });
});

describe("model-visible sanitizer withholds raw plan material", () => {
  it("replaces sealed records and plan bytes with explicit markers wherever they sit", () => {
    const record = sealed(), plan = planBase64();
    const { value, report } = sanitizeForModel({ review: { note: "ok" }, nested: [{ custody: record }, { text: plan }], other: { ciphertext: record.ciphertext, authTag: record.authTag } });
    const text = JSON.stringify(value);
    expect(text).not.toContain(record.ciphertext);
    expect(text).not.toContain(plan.slice(0, 60));
    expect(text).toContain("[REDACTED:raw-plan-material]");
    expect(report.kinds).toContain("raw-plan-material");
    expect(report.completeness).toBe("best_effort");
  });
  it("still passes an ordinary PlanView unchanged", () => {
    const digest = DIGEST_B;
    expect(sanitizeForModel({ view: view(digest) }).value).toEqual({ view: view(digest) });
  });
  it("does not make raw-plan detection look like a credential shape", () => {
    expect(detectCredentialShapes({ custody: sealed() })).toEqual([]);
  });
  it("every MCP v3 envelope scrubs raw custody material, data and untrusted alike", () => {
    const record = sealed(), plan = planBase64();
    const envelope = buildEnvelope({ name: "zenith_get_operation", schemaVersion: 1 }, { data: { artifact: record }, untrusted: { note: { raw: plan } } });
    const text = JSON.stringify(envelope);
    expect(text).not.toContain(record.ciphertext);
    expect(text).not.toContain(plan.slice(0, 60));
    expect(text).toContain("raw-plan-material");
  });
});

describe("stored PlanView projection", () => {
  const digest = DIGEST_C;
  const summary = (extra: Record<string, unknown> = {}) => ({ stage: "plan", planDigest: digest, view: view(digest), facts, cost: {}, ...extra });
  it("projects a clean summary and fails closed when raw custody material is present", () => {
    expect(projectPlanReview(summary(), digest)?.view.planDigest).toBe(digest);
    expect(projectPlanReview(summary({ artifact: sealed() }), digest)).toBeUndefined();
    expect(projectPlanReview(summary({ custody: { planFile: "x" } }), digest)).toBeUndefined();
  });
  it("the projection never carries members the PlanView schema does not name", () => {
    const projected = projectPlanReview(summary({ view: { ...view(digest), rawSha256: "a".repeat(64), planBytes: "x" } }), digest);
    expect(projected).toBeUndefined();
  });
});
