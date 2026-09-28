import { z } from "zod";

export const waitlistSubmissionSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  name: z.string().trim().max(120).default(""),
  occupation: z.string().trim().max(120).default(""),
  features: z.array(z.string().trim().min(1).max(120)).max(12).default([])
    .transform((values) => [...new Set(values)]),
  useCase: z.string().trim().max(2000).default(""),
}).strict();

export const waitlistAdmissionSchema = z.union([
  z.object({
    count: z.number().int().min(1).max(1000),
    requestId: z.string().uuid(),
  }).strict(),
  z.object({
    previewId: z.string().uuid(),
    requestId: z.string().uuid(),
  }).strict(),
]);

export const waitlistPreviewSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("selected"),
    entryIds: z.array(z.string().uuid().transform((id) => id.toLowerCase())).min(1).max(1000)
      .refine((ids) => new Set(ids).size === ids.length, "Choose each person only once."),
  }).strict(),
  z.object({
    mode: z.literal("next"),
    count: z.number().int().min(1).max(1000),
  }).strict(),
  z.object({ mode: z.literal("all") }).strict(),
]);

export const waitlistPreviewIdSchema = z.string().uuid();
export const waitlistHistorySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const waitlistHistoryDetailSchema = z.object({
  offset: z.coerce.number().int().min(0).max(2147483647).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict();

export const waitlistListSchema = z.object({
  status: z.enum(["queued", "admitted"]).optional(),
  after: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  q: z.string().trim().max(254).optional(),
}).strict();
