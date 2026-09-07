/**
 * The per-app customer data layer — the fixed broker's storage side.
 *
 * The one import for wave-2 consumers:
 *
 *   import { openAppData, TrackerDataStore } from "@/lib/hosted/data";
 *
 * Typical use from the gateway: `openAppData(app.id).store`, then `list`,
 * `get`, `create` or `update` with a `DataContext` built from the admitted
 * session. Everything else here exists for the release runner (test database
 * reset, schema version), ops (storage bytes, write-ledger purge) and the
 * Cloudflare runtime (the D1 backend).
 *
 * Workstream W3 (hosted R3).
 */
export {
  type AsyncDataBackend,
  type D1BatchOutcome,
  type D1BatchStatement,
  D1HttpBackend,
  type D1HttpBackendOptions,
  type D1TransactionScope,
  type DataBackend,
  type RunResult,
  SqliteBackend,
  type SqliteBackendOptions,
  type SqlitePragmaReadback,
  type SqlParam,
} from "./backend";
export {
  LOGICAL_BYTES_DISCLOSURE,
  LOGICAL_BYTE_FIELDS,
  ROW_OVERHEAD_BYTES,
  logicalBytes,
} from "./bytes";
export { stableStringify, writeIntentHash } from "./intent";
export {
  APP_DATA_FILENAMES,
  type AppDataFile,
  appDataPath,
  closeAllAppData,
  closeAppData,
  type OpenAppData,
  type OpenAppDataOptions,
  openAppData,
  resetTestDatabase,
} from "./open";
export {
  LATEST_TRACKER_SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  TRACKER_MIGRATIONS,
  type TrackerMigration,
  applyTrackerMigrations,
  readSchemaVersion,
} from "./schema";
export {
  type CreateRequestInput,
  type CursorPayload,
  type ListRequestsInput,
  type MutationResult,
  TrackerDataStore,
  type TrackerDataStoreOptions,
  type UpdateRequestInput,
  decodeCursor,
  encodeCursor,
} from "./store";
export * as trackerSql from "./sql";
