/** Strict additive MCP review schema; identifiers and flags only. */
import { z } from "zod/v4";
import { EnvTarget, IdempotencyKey } from "./schemas";
export const ReviewTeardownInput = z.strictObject({ target: EnvTarget, idempotencyKey: IdempotencyKey, refresh: z.boolean().optional() });
