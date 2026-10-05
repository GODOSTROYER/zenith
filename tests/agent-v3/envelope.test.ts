/** Tool results label external text and scrub canaries even when an adapter
 * violates its own redaction contract. Size limits apply to errors as well. */
import { describe, expect, it, vi } from "vitest";
import { buildEnvelope, buildErrorEnvelope, MAX_RESULT_BYTES, toCallToolResult } from "@/lib/agent-access/v3/envelope";
import { mapError, McpToolError } from "@/lib/agent-access/v3/errors";
import { UNTRUSTED_NOTE, TOOL_NAMES } from "@/lib/agent-access/v3/contract";
import { argsFor, canaries, ids, makeHarness, proposeDeploy } from "./support";

const tool = { name: "zenith_query_logs", schemaVersion: 1 };
const assertSafe = (value: unknown) => { for (const canary of canaries) expect(JSON.stringify(value)).not.toContain(canary); };

it.each(TOOL_NAMES)("%s always carries the untrusted-data note, including failures", async (name) => {
  const h = await makeHarness(); const p = await proposeDeploy(h);
  const result = await h.invoke(name, argsFor(name, p.id, p.digest));
  expect(result.note).toBe(UNTRUSTED_NOTE);
  expect((await h.invoke(name, { ...argsFor(name), approved: true })).note).toBe(UNTRUSTED_NOTE);
});
describe("untrusted framing", () => {
  it("manifest names, revision messages and log messages appear only under untrusted_data", async () => {
    const h = await makeHarness();
    const topology = await h.invoke("zenith_get_topology", argsFor("zenith_get_topology"));
    const logs = await h.invoke("zenith_query_logs", argsFor("zenith_query_logs"));
    for (const [envelope, markers] of [[topology, ["web-app", "PUBLIC_MARKER", "revision-message-marker"]], [logs, ["log-message-marker"]]] as const) {
      expect(envelope.untrusted_data?.label).toBe("untrusted_data");
      for (const marker of markers) {
        expect(JSON.stringify(envelope.untrusted_data)).toContain(marker);
        expect(JSON.stringify({ ...envelope, untrusted_data: undefined })).not.toContain(marker);
      }
    }
    expect(JSON.stringify(topology)).not.toContain("config-value-never-return");
  });
  it("diff field values are omitted", async () => {
    const h = await makeHarness(); h.revisions.get(ids.revision2)!.manifest.services[0].env[0].value = "changed-config-never-return";
    const result = await h.invoke("zenith_compare_revisions", argsFor("zenith_compare_revisions"));
    expect(result.ok).toBe(true); expect(JSON.stringify(result)).not.toContain("changed-config-never-return");
    expect(result.untrusted_data?.content.changes).toEqual(expect.arrayContaining([expect.objectContaining({ changedFields: expect.any(Array) })]));
  });
  it("operation reasons, executor results/errors, approvers and event payloads remain data", async () => {
    const h = await makeHarness(); const p = await proposeDeploy(h);
    const detail = await h.broker.getOperationDetail({ workspaceId: ids.ws, operationId: p.id, principal: h.principal.principal });
    detail.operation.proposal.details.push("operator-reason-marker"); detail.operation.error = "executor-error-marker";
    detail.operation.result = { message: "executor-result-marker" };
    h.getOperationDetail.mockResolvedValue(detail);
    h.broker.listOperationEvents = vi.fn(async () => ({ items: [{ seq: 1, id: "event-a", ts: h.clock.now().toISOString(), type: "operation.failed", correlationId: "corr-a", data: { message: "event-text-marker" } }] }));
    for (const name of ["zenith_get_operation", "zenith_get_operation_events"] as const) {
      const result = await h.invoke(name, argsFor(name, p.id));
      const text = JSON.stringify(result.untrusted_data);
      expect(text).toContain(name === "zenith_get_operation" ? "executor-error-marker" : "event-text-marker");
      expect(JSON.stringify(result.data)).not.toMatch(/operator-reason-marker|executor-error-marker|executor-result-marker|event-text-marker/);
    }
  });
});

it.each(canaries)("scrubs canary from every envelope field: %s", (canary) => {
  const result = buildEnvelope(tool, { data: { id: canary }, untrusted: { message: canary, [canary]: canary }, notes: [canary], unavailable: [{ source: canary, reason: canary }] });
  assertSafe(toCallToolResult(result));
  assertSafe(buildErrorEnvelope(tool, { code: "test", message: canary, fix: canary, details: { value: canary }, retryable: false }));
});
it("scrubs canaries from leaky logs, operation results/errors and events", async () => {
  const h = await makeHarness(); const p = await proposeDeploy(h);
  h.logResult.items[0].message = canaries.join(" ");
  assertSafe(await h.invoke("zenith_query_logs", argsFor("zenith_query_logs")));
  const detail = await h.broker.getOperationDetail({ workspaceId: ids.ws, operationId: p.id, principal: h.principal.principal });
  detail.operation.error = canaries.join(" "); detail.operation.result = { value: canaries };
  h.getOperationDetail.mockResolvedValue(detail);
  h.broker.listOperationEvents = vi.fn(async () => ({ items: [{ seq: 1, id: "event-a", ts: h.clock.now().toISOString(), type: "operation.failed", correlationId: "corr-a", data: { message: canaries.join(" ") } }] }));
  assertSafe(await h.invoke("zenith_get_operation", argsFor("zenith_get_operation", p.id)));
  assertSafe(await h.invoke("zenith_get_operation_events", argsFor("zenith_get_operation_events", p.id)));
});
it("scrubs unexpected errors in diagnostic logging as well as responses", () => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    assertSafe(mapError(new Error(canaries.join(" "))));
    assertSafe(stderr.mock.calls);
  } finally { stderr.mockRestore(); }
});
it("halves large lists, marks truncation and stays under 256 KiB", () => {
  const result = buildEnvelope(tool, { data: {}, untrusted: { logs: Array.from({ length: 1000 }, () => ({ message: ".".repeat(1000) })) } });
  expect(result.truncated).toBe(true); expect(result.notes.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  expect((result.untrusted_data?.content.logs as unknown[]).length).toBeLessThan(1000);
});
it("a single uncuttable value becomes a bounded error", () => {
  expect(() => buildEnvelope(tool, { data: { value: ".".repeat(200_000) } }, 1024)).toThrowError(McpToolError);
  const error = buildErrorEnvelope(tool, { code: "test", message: "Error", details: { entries: Array.from({ length: 1000 }, () => ".".repeat(1000)) }, retryable: false });
  expect(error.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(error))).toBeLessThanOrEqual(MAX_RESULT_BYTES);
});
it("still redacts credential-shaped bulk before applying the envelope byte budget", () => {
  for (const length of [1000, 200_000]) {
    const result = buildEnvelope(tool, { data: { value: "x".repeat(length) } });
    expect(result.data.value).toBe("[REDACTED BLOB]");
    expect(result.truncated).toBe(false);
    expect(result.notes.some((note) => note.includes("long-base64"))).toBe(true);
    assertSafe(result);
  }
});
