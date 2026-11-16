/** Real action/audit storage with synthetic secrets; no provider calls. */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { tempDataDir } from "../_support/data-dir";
import { assertNoCanaries, canarySecret } from "../_support/security";

tempDataDir("zenith-audit-boundary-", { fast: true });
const { defineAction, runAction } = await import("@/lib/actions/core");
const { readAudit, resetDb } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const workspaceId = "ws-audit-boundary";
const ctx = { workspaceId, actor: { type: "user" as const, id: "audit-admin", name: "Admin" } };

defineAction({
  id: "test.audit-boundary", title: "Audit boundary probe", category: "system",
  risk: "low", requiredRole: "viewer", mutates: true,
  input: z.object({ password: z.string(), throws: z.boolean(), padding: z.number().optional() }),
  plan: () => ({ summary: "probe", details: [], warnings: [], costDeltaUsd: 0, risk: "low", requiresApproval: false }),
  execute: (_ctx, input) => {
    const message = `${"x".repeat(input.padding ?? 0)} provider echoed ${input.password}`;
    if (input.throws) throw new Error(message);
    return { ok: false, summary: message, error: message };
  },
});

beforeEach(() => {
  resetDb({
    workspaces: [{ id: workspaceId, name: "Audit", slug: "audit", createdAt: "2026-10-01T00:00:00.000Z" }],
    members: [{ id: ctx.actor.id, workspaceId, name: "Admin", email: "audit@zenith.test", role: "admin" }],
  });
});

const execute = (actionId: string, input: unknown) => runAction(actionId, ctx, input, { mode: "execute" });
const rows = () => readAudit({ workspaceId, limit: 50 });

describe("audit source and diagnostic boundaries", () => {
  it.each(["short", "large"])("omits %s compose source, including neutral plaintext env values", async (size) => {
    const secret = canarySecret(`audit-compose-${size}`, "password");
    const composeYaml = `services:\n  api:\n    image: node:22\n    environment:\n      DIAGNOSTIC: ${secret}\n${size === "large" ? `# ${"x".repeat(8_000)}` : ""}`;
    const out = await execute("project.importCompose", { composeYaml, name: "Imported" });
    expect(out.result?.ok).toBe(true);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].input).toMatchObject({ name: "Imported", composeYaml: { omitted: true, characters: composeYaml.length } });
    expect(JSON.stringify(rows())).not.toContain("services:");
    assertNoCanaries(rows(), [secret], "source contents never enter the audit projection");
    expect(Buffer.byteLength(JSON.stringify(rows()[0].input))).toBeLessThan(4096);
  });

  it("omits parser diagnostics from failed compose imports", async () => {
    const secret = canarySecret("audit-invalid-compose", "password");
    const out = await execute("project.importCompose", { composeYaml: `services: [${secret}` });
    expect(out.result?.ok).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ result: "error", summary: "Compose import: error." + " Source text omitted." });
    expect(rows()[0].error).toContain("diagnostic omitted");
    assertNoCanaries(rows(), [secret], "parse errors can quote source, so audit keeps a fixed reason");
  });

  it.each([false, true])("redacts exact secret input echoes from returned/thrown errors (throws=%s)", async (throws) => {
    const secret = canarySecret(`audit-error-${throws}`, "password");
    await execute("test.audit-boundary", { password: secret, throws });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].error).toContain("[REDACTED]");
    assertNoCanaries(rows(), [secret], "summary and error receive the same secret boundary as input");
  });

  it("bounds diagnostics after redaction", async () => {
    const secret = canarySecret("audit-error-bound", "aws-access-key-id");
    await execute("test.audit-boundary", { password: secret, throws: false, padding: 8_000 });
    const row = rows()[0];
    expect(Buffer.byteLength(row.summary)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(row.error!)).toBeLessThanOrEqual(4096);
    assertNoCanaries(row, [secret], "no raw value or partial echo survives the text budget");
  });
});
