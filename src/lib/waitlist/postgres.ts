import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError } from "@/lib/server/errors";
import type { WaitlistEntry, WaitlistPage, WaitlistRepository } from "./types";

type EntryRow = {
  id: string;
  email: string;
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
    if (error?.code === "ZW409") {
      throw new ApiError("This request ID was already used for another admission.", 409);
    }
    if (error && ["22023", "22001", "22P02", "23502", "23514"].includes(error.code)) {
      throw new ApiError("Invalid waitlist input.", 400);
    }
    if (error) throw new ApiError("Waitlist storage is unavailable. Please try again.", 500);
    return data as T;
  }

  return {
    async join(input) {
      await rpc("zenith_waitlist_join", {
        p_email: input.email.trim().toLowerCase(),
        p_occupation: input.occupation,
        p_use_case: input.useCase,
      });
    },

    async list(options) {
      const result = await rpc<{
        entries: EntryRow[];
        total: number;
        queued: number;
        admitted: number;
        nextCursor: number | null;
      }>("zenith_waitlist_list", {
        p_status: options.status ?? null,
        p_after: options.after ?? 0,
        p_limit: options.limit,
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
