/**
 * What the Cloudflare adapter is willing to believe about a provider response,
 * and what it is willing to allow on a script.
 *
 * Two jobs, both of them refusals. The coercers turn an untyped API payload
 * into the two shapes this runtime uses, discarding anything that does not fit
 * rather than passing an unchecked object along. The allowlists answer the only
 * question the isolation argument rests on: **a release may reach nothing but
 * its own files, and only the fixed broker may reach data.** An extra binding,
 * an unexpected field or a database that is not the app's own is `false` — not
 * "probably fine" — because an unexpected binding *is* that argument failing.
 *
 * Nothing here does I/O or knows about an account: it is pure, so the readback
 * rules can be read, and tested, without a Cloudflare token.
 */
import { cfRefusal } from "./cf-api";

/** A D1 database as this adapter uses it: the id it binds and the name it listed under. */
export interface D1Database {
  uuid: string;
  name: string;
}

/* ------------------------------ script upload ----------------------------- */

/** The multipart body a Workers script upload takes: metadata plus one module. */
export function scriptUpload(input: { module: string; metadata: Record<string, unknown> }): FormData {
  const form = new FormData();
  const main = String(input.metadata.main_module ?? "index.mjs");
  form.append("metadata", new Blob([JSON.stringify(input.metadata)], { type: "application/json" }));
  form.append(main, new Blob([input.module], { type: "application/javascript+module" }), main);
  return form;
}

/* -------------------------------- coercers -------------------------------- */

export const asDatabases = (value: unknown): D1Database[] =>
  Array.isArray(value)
    ? value
        .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
        .map((row) => ({ uuid: String(row.uuid ?? ""), name: String(row.name ?? "") }))
        .filter((row) => row.uuid !== "")
    : [];

export function asDatabase(value: unknown): D1Database {
  const [first] = asDatabases([value]);
  if (!first)
    throw cfRefusal(
      "Cloudflare did not return the database it was asked to create.",
      "Try publishing again. If the database exists in the dashboard, this adapter will adopt it on the next attempt."
    );
  return first;
}

export const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((row): row is string => typeof row === "string") : [];

/** A one-line description per binding, for the readback report. */
export const describe = (bindings: unknown[]): string[] =>
  bindings.map((binding) => {
    if (typeof binding !== "object" || binding === null) return "an unreadable binding";
    const row = binding as Record<string, unknown>;
    return `${String(row.name ?? "?")} (${String(row.type ?? "?")})`;
  });

/* ------------------------------- allowlists ------------------------------- */

/** A release may have nothing, or exactly the assets binding — and no extra fields. */
export function isAllowedReleaseBindings(bindings: unknown[]): boolean {
  if (bindings.length === 0) return true;
  if (bindings.length !== 1) return false;
  const row = bindings[0];
  if (typeof row !== "object" || row === null) return false;
  const binding = row as Record<string, unknown>;
  return (
    binding.type === "assets" &&
    binding.name === "ASSETS" &&
    Object.keys(binding).every((key) => key === "type" || key === "name")
  );
}

/** A broker must have exactly one d1 binding called DB, on the expected database. */
export function isAllowedBrokerBindings(bindings: unknown[], expectedDatabase?: string): boolean {
  if (bindings.length !== 1) return false;
  const row = bindings[0];
  if (typeof row !== "object" || row === null) return false;
  const binding = row as Record<string, unknown>;
  if (binding.type !== "d1" || binding.name !== "DB") return false;
  if (!Object.keys(binding).every((key) => ["type", "name", "id", "database_id", "database_name"].includes(key)))
    return false;
  if (expectedDatabase === undefined) return true;
  const id = binding.database_id ?? binding.id;
  if (id !== expectedDatabase) return false;
  // The deprecated `id` field, when present alongside `database_id`, must agree.
  if ("id" in binding && "database_id" in binding && binding.id !== binding.database_id) return false;
  return true;
}
