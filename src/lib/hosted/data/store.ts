/**
 * Moved. `TrackerDataStore` is the *tracker's* store — the equipment-request
 * reference app's `AppDataStore` — not "the data store", and a file called
 * `store.ts` in a directory that is meant to hold more than one app's data
 * plane said the opposite. It now lives in `tracker-store.ts`, with its row
 * mappers and refusals in `tracker-rows.ts`.
 *
 * This file is a re-export so existing `@/lib/hosted/data/store` imports keep
 * resolving. New code should import from `@/lib/hosted/data` (the barrel).
 *
 * Workstream W3 (hosted R3).
 */
export {
  TrackerDataStore,
  decodeCursor,
  encodeCursor,
  type CreateRequestInput,
  type CursorPayload,
  type ListRequestsInput,
  type MutationResult,
  type TrackerDataStoreOptions,
  type UpdateRequestInput,
} from "./tracker-store";
