/**
 * The disclosed "logical bytes" measure behind the storage quota (decision
 * R3-12).
 *
 * What it measures: the UTF-8 byte length of the JSON encoding of a stored
 * record's own fields, plus a flat per-row overhead. What it does NOT measure:
 * the physical size of the SQLite or D1 database — indexes, page overhead,
 * the WAL, free pages and the write-id ledger are all outside it. The gap
 * analysis is explicit that no provider demonstrates a strict physical cap
 * before a write, so the hosted contract enforces this logical figure instead
 * and says so wherever the number is shown.
 *
 * Workstream W3 (hosted R3).
 */
import type { EquipmentRequest } from "@/lib/hosted/contracts";

/**
 * Flat per-row allowance for everything the JSON encoding does not name: the
 * row header, the primary-key index entry and the ordering index entry. A
 * constant rather than a measurement, because the measure has to be identical
 * on SQLite and on D1 for the same record.
 */
export const ROW_OVERHEAD_BYTES = 64;

/**
 * Exactly which fields are counted, in exactly this order. Changing this list
 * or its order changes every app's reported usage, so it is part of the
 * disclosed contract, not an implementation detail.
 *
 * Note `version` and `updatedAt` are counted: an update therefore changes a
 * record's logical size slightly, and the store applies that delta to the
 * running total like any other change.
 */
export const LOGICAL_BYTE_FIELDS = [
  "id",
  "title",
  "details",
  "category",
  "quantity",
  "priority",
  "status",
  "requestedFor",
  "neededBy",
  "version",
  "createdBy",
  "createdByEmail",
  "createdAt",
  "updatedBy",
  "updatedByEmail",
  "updatedAt",
] as const;

/**
 * The logical byte size of one stored equipment request.
 *
 * `JSON.stringify` over the fields in {@link LOGICAL_BYTE_FIELDS}, measured as
 * UTF-8, plus {@link ROW_OVERHEAD_BYTES}. Deterministic: the key order is fixed
 * by that list rather than by the caller's object, so the same record always
 * measures the same on any host.
 */
export function logicalBytes(record: EquipmentRequest): number {
  const canonical = {
    id: record.id,
    title: record.title,
    details: record.details,
    category: record.category,
    quantity: record.quantity,
    priority: record.priority,
    status: record.status,
    requestedFor: record.requestedFor,
    neededBy: record.neededBy,
    version: record.version,
    createdBy: record.createdBy,
    createdByEmail: record.createdByEmail,
    createdAt: record.createdAt,
    updatedBy: record.updatedBy,
    updatedByEmail: record.updatedByEmail,
    updatedAt: record.updatedAt,
  };
  return Buffer.byteLength(JSON.stringify(canonical), "utf8") + ROW_OVERHEAD_BYTES;
}

/** How the quota figure is described wherever it is shown to a person. */
export const LOGICAL_BYTES_DISCLOSURE =
  "Storage is measured as logical bytes: the UTF-8 JSON size of each request's stored fields plus a fixed 64-byte row allowance. It is not the physical size of the database file.";
