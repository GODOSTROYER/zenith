import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/server/errors";
import type { WaitlistAdmissionHistory, WaitlistAdmissionPreview, WaitlistAdmissionResult, WaitlistEntry, WaitlistPage, WaitlistRepository } from "./types";
import { waitlistHistoryDetailSchema, waitlistHistorySchema, waitlistListSchema, waitlistPreviewIdSchema, waitlistPreviewSchema, waitlistSubmissionSchema } from "./validation";
import { WaitlistPreviewExpiredError } from "./errors";

type EntryRow = {
  id: string;
  email: string;
  name?: string;
  features?: string[];
  occupation: string;
  use_case: string;
  position: number;
  status: WaitlistEntry["status"];
  created_at: string;
  admitted_at: string | null;
  admitted_by: string | null;
};

function entry(row: EntryRow): WaitlistEntry {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? "",
    features: row.features ?? [],
    occupation: row.occupation,
    useCase: row.use_case,
    position: row.position,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    admittedAt: row.admitted_at ? new Date(row.admitted_at).toISOString() : null,
    admittedBy: row.admitted_by,
  };
}

/** Independent of workspace snapshots: each RPC reads or commits durable state. */
export function postgresWaitlistRepository(): WaitlistRepository {
  // Lazy construction keeps file-backed installs free of Supabase requirements.
  let client: ReturnType<typeof createAdminClient> | undefined;
  async function rpc<T>(name: string, parameters: Record<string, unknown>): Promise<T> {
    client ??= createAdminClient();
    const { data, error } = await client.rpc(name, parameters);
    // Do not propagate database detail that can contain submitted email addresses.
    if (error?.code === "ZW410") throw new WaitlistPreviewExpiredError();
    if (error?.code === "ZW409") {
      throw new ApiError("This approval request conflicts with an earlier action or an unavailable preview. Refresh the queue and review a new approval.", 409);
    }
    if (error && ["22023", "22001", "22P02", "23502", "23514"].includes(error.code)) {
      throw new ApiError("Invalid waitlist input.", 400);
    }
    if (error) throw new ApiError("Waitlist storage is unavailable. Please try again.", 500);
    return data as T;
  }

  return {
    async join(input) {
      const parsed = waitlistSubmissionSchema.parse(input);
      await rpc("zenith_waitlist_join_profile", {
        p_email: parsed.email,
        p_name: parsed.name,
        p_occupation: parsed.occupation,
        p_features: parsed.features,
        p_use_case: parsed.useCase,
      });
    },

    async list(options) {
      const parsed = waitlistListSchema.parse(options);
      const result = await rpc<{
        entries: EntryRow[];
        total: number;
        queued: number;
        admitted: number;
        matched: number;
        nextCursor: number | null;
      }>("zenith_waitlist_list_filtered", {
        p_status: parsed.status ?? null,
        p_after: parsed.after ?? 0,
        p_limit: parsed.limit,
        p_query: parsed.q ?? "",
      });
      return { ...result, entries: result.entries.map(entry) } satisfies WaitlistPage;
    },

    async admit(count, actorId, requestId) {
      const rows = await rpc<EntryRow[]>("zenith_waitlist_admit", {
        p_count: count,
        p_actor_id: actorId,
        p_request_id: requestId,
      });
      return rows.map(entry);
    },

    async preview(selection, actorId) {
      const parsed = waitlistPreviewSchema.safeParse(selection);
      if (!parsed.success || !actorId.trim() || actorId.length > 200)
        throw new ApiError("Invalid waitlist approval preview.", 400);
      const result = await rpc<Omit<WaitlistAdmissionPreview, "entries"> & { entries: EntryRow[] }>(
        "zenith_waitlist_preview", {
          p_mode: parsed.data.mode,
          p_actor_id: actorId,
          p_count: parsed.data.mode === "next" ? parsed.data.count : null,
          p_entry_ids: parsed.data.mode === "selected" ? parsed.data.entryIds : null,
        },
      );
      return {
        ...result, entries: result.entries.map(entry),
        createdAt: new Date(result.createdAt).toISOString(),
        expiresAt: new Date(result.expiresAt).toISOString(),
      };
    },

    async admitPreview(previewId, actorId, requestId) {
      if (!waitlistPreviewIdSchema.safeParse(previewId).success
        || !actorId.trim() || actorId.length > 200 || !requestId.trim() || requestId.length > 128)
        throw new ApiError("Invalid waitlist admission request.", 400);
      return rpc<WaitlistAdmissionResult>("zenith_waitlist_admit_preview", {
        p_preview_id: previewId.toLowerCase(), p_actor_id: actorId, p_request_id: requestId,
      });
    },

    async history(options) {
      const parsed = waitlistHistorySchema.safeParse(options);
      if (!parsed.success) throw new ApiError("Invalid approval history query.", 400);
      const result = await rpc<WaitlistAdmissionHistory>("zenith_waitlist_history", { p_limit: parsed.data.limit });
      return { batches: result.batches.map((batch) => ({ ...batch, createdAt: new Date(batch.createdAt).toISOString() })) };
    },

    async historyDetail(requestId, options = {}) {
      const parsed = waitlistHistoryDetailSchema.safeParse(options);
      if (!parsed.success || !requestId.trim() || requestId.length > 128)
        throw new ApiError("Invalid approval history request.", 400);
      const result = await rpc<{ batch: WaitlistAdmissionHistory["batches"][number]; entries: EntryRow[]; nextOffset: number | null } | null>(
        "zenith_waitlist_history_detail", { p_request_id: requestId, p_offset: parsed.data.offset, p_limit: parsed.data.limit },
      );
      if (!result) throw new ApiError("This approval batch was not found.", 404);
      return {
        batch: { ...result.batch, createdAt: new Date(result.batch.createdAt).toISOString() },
        entries: result.entries.map(entry),
        nextOffset: result.nextOffset,
      };
    },

    async admitted(email) {
      return rpc<boolean>("zenith_waitlist_admitted", {
        p_email: email.trim().toLowerCase(),
      });
    },

    async consumeRateLimit(key, limit, windowSeconds) {
      return rpc<boolean>("zenith_waitlist_rate_limit", {
        p_key: key,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
    },
  };
}
