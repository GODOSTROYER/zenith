/** Identifier-only review drafts. A draft is never an approval or execution grant. */
import { z } from "zod";
import { findSecret } from "@/lib/capabilities/secret-guard";
import { ConnectionRef, CreateRunnerInput, RevokeInput, RotateInput, RotationRef } from "./schemas";

export const RUNNER_ACTIONS = ["connection.createRunner", "connection.verify", "connection.rotate", "connection.promoteRotation", "connection.abortRotation", "connection.revoke"] as const;
export const ConnectionRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connection.createRunner"), input: CreateRunnerInput }).strict(),
  z.object({ action: z.literal("connection.verify"), input: ConnectionRef }).strict(),
  z.object({ action: z.literal("connection.rotate"), input: RotateInput }).strict(),
  z.object({ action: z.literal("connection.promoteRotation"), input: RotationRef }).strict(),
  z.object({ action: z.literal("connection.abortRotation"), input: RotationRef.omit({ retirePreviousRunner: true }) }).strict(),
  z.object({ action: z.literal("connection.revoke"), input: RevokeInput }).strict(),
]).superRefine((value, ctx) => {
  if (findSecret(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Connection drafts hold identifiers only. Remove credential material." });
  if (value.action === "connection.rotate" && Object.keys(value.input.patch).some(key => /^(approved|approval|approvedBy|actor|principal|role|policy|autonomy)$/i.test(key))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Connection drafts cannot carry approval or authority overrides." });
  }
});
export type ConnectionRequest = z.infer<typeof ConnectionRequest>;
const Draft = z.object({ version: z.literal(1), workspaceId: z.string().min(1).max(128).optional(), request: ConnectionRequest }).strict();
export type ConnectionDraft = z.infer<typeof Draft>;
const MAX_DRAFT = 16_384;

export function connectionHandoff(request: ConnectionRequest, workspaceId?: string): string {
  const draft = Draft.parse({ version: 1, ...(workspaceId ? { workspaceId } : {}), request });
  const json = JSON.stringify(draft);
  if (json.length > MAX_DRAFT) throw new Error("This connection draft is too large. Enter the identifiers in the connection screen.");
  // Fragments stay out of HTTP requests, access logs and redirect query strings.
  return `/platform/connections/confirm#${encodeURIComponent(json)}`;
}

export function parseConnectionHandoff(fragment: string): ConnectionDraft {
  if (fragment.length > MAX_DRAFT * 3 + 1) throw new Error("This connection draft is too large.");
  const json = decodeURIComponent(fragment.replace(/^#/, ""));
  if (json.length > MAX_DRAFT) throw new Error("This connection draft is too large.");
  return Draft.parse(JSON.parse(json));
}

export function connectionMutation(request: ConnectionRequest): { path: string; body: unknown } {
  if (request.action === "connection.createRunner") return { path: "/api/platform/v1/connections", body: request.input };
  const { connectionId, ...fields } = request.input;
  const body = request.action === "connection.revoke" ? { ...fields, confirm: connectionId } : fields;
  const suffix = { "connection.verify": "verify", "connection.rotate": "rotate", "connection.promoteRotation": "rotation/promote", "connection.abortRotation": "rotation/abort", "connection.revoke": "revoke" }[request.action];
  return { path: `/api/platform/v1/connections/${encodeURIComponent(connectionId)}/${suffix}`, body };
}
