import { z } from "zod";

export const waitlistSubmissionSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  occupation: z.string().trim().min(1).max(120),
  useCase: z.string().trim().min(1).max(2000),
}).strict();

export const waitlistAdmissionSchema = z.object({
  count: z.number().int().min(1).max(1000),
  requestId: z.string().uuid(),
}).strict();

export const waitlistListSchema = z.object({
  status: z.enum(["queued", "admitted"]).optional(),
  after: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();