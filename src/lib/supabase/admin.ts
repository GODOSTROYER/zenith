/**
 * Service-role client. SERVER ONLY — never import from client code.
 * Used by the test-account seeder and (later) admin operations.
 */
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL } from "./env";

type AdminClient = ReturnType<typeof createClient>;
interface DataDescriptor { value: unknown; writable: boolean; enumerable: boolean; configurable: boolean }
interface DefaultAdminIdentity {
  target: string; from: AdminClient["from"]; schema: AdminClient["schema"];
  prototype: object; rest: object; restTarget: string; restSchema: "public";
  restDescriptor: DataDescriptor; restPrototype: object;
  restFrom: DataDescriptor; restSchemaMethod: DataDescriptor; restFetch: DataDescriptor;
  restUrl: DataDescriptor; restSchemaName: DataDescriptor;
}
const defaultAdminKey = Symbol.for("zenith.supabase.default-admin-clients.v1");
const defaultAdminGlobal = globalThis as typeof globalThis & { [defaultAdminKey]?: WeakMap<object, DefaultAdminIdentity> };
const defaultAdmins = defaultAdminGlobal[defaultAdminKey] ??= new WeakMap<object, DefaultAdminIdentity>();
function ownValue(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function dataDescriptor(value: object, name: string): DataDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && "value" in descriptor ? Object.freeze({ value: descriptor.value,
    writable: descriptor.writable === true, enumerable: descriptor.enumerable === true, configurable: descriptor.configurable === true }) : undefined;
}
function sameDescriptor(value: object, name: string, captured: DataDescriptor | undefined): boolean {
  const descriptor = dataDescriptor(value, name);
  return !!descriptor && !!captured && descriptor.value === captured.value && descriptor.writable === captured.writable
    && descriptor.enumerable === captured.enumerable && descriptor.configurable === captured.configurable;
}
function target(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) return;
    return parsed.origin;
  } catch { return; }
}

/** Fixed scalar provenance predicate. It exposes no key, headers or client options. */
export function isDefaultAdminClientFor(value: unknown, origin: string): boolean {
  if (!value || typeof value !== "object") return false;
  const captured = defaultAdmins.get(value), current = target(origin);
  if (!captured || !current || current !== captured.target || target(SUPABASE_URL) !== captured.target) return false;
  const rest = ownValue(value, "rest");
  return Object.getOwnPropertyDescriptor(value, "from") === undefined && Object.getOwnPropertyDescriptor(value, "schema") === undefined
    && Object.getPrototypeOf(value) === captured.prototype
    && ownValue(captured.prototype, "from") === captured.from && ownValue(captured.prototype, "schema") === captured.schema
    && rest === captured.rest && sameDescriptor(value, "rest", captured.restDescriptor)
    && Object.getPrototypeOf(captured.rest) === captured.restPrototype
    && Object.getOwnPropertyDescriptor(captured.rest, "from") === undefined && Object.getOwnPropertyDescriptor(captured.rest, "schema") === undefined
    && sameDescriptor(captured.restPrototype, "from", captured.restFrom) && sameDescriptor(captured.restPrototype, "schema", captured.restSchemaMethod)
    && sameDescriptor(captured.rest, "fetch", captured.restFetch) && sameDescriptor(captured.rest, "url", captured.restUrl)
    && sameDescriptor(captured.rest, "schemaName", captured.restSchemaName);
}

export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY (and NEXT_PUBLIC_SUPABASE_URL) are required for admin operations. Add them to .env.local — the service role key is server-only and must never ship to the browser."
    );
  }
  const client = createClient(SUPABASE_URL, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const origin = target(SUPABASE_URL), rest = ownValue(client, "rest"), prototype: unknown = Object.getPrototypeOf(client);
  // Preserve construction behavior for every existing caller. Only the known
  // public-schema default construction is recorded as native MCP provenance.
  if (origin && rest && typeof rest === "object" && prototype && typeof prototype === "object"
    && ownValue(prototype, "from") === client.from && ownValue(prototype, "schema") === client.schema
    && ownValue(rest, "url") === `${origin}/rest/v1` && ownValue(rest, "schemaName") === "public") {
    const restPrototype: unknown = Object.getPrototypeOf(rest), restDescriptor = dataDescriptor(client, "rest"),
      restFetch = dataDescriptor(rest, "fetch"), restUrl = dataDescriptor(rest, "url"), restSchemaName = dataDescriptor(rest, "schemaName");
    const restFrom = restPrototype && typeof restPrototype === "object" ? dataDescriptor(restPrototype, "from") : undefined;
    const restSchemaMethod = restPrototype && typeof restPrototype === "object" ? dataDescriptor(restPrototype, "schema") : undefined;
    if (restPrototype && typeof restPrototype === "object" && restDescriptor && restFetch && typeof restFetch.value === "function"
      && restFrom && typeof restFrom.value === "function" && restSchemaMethod && typeof restSchemaMethod.value === "function" && restUrl && restSchemaName
      && Object.getOwnPropertyDescriptor(rest, "from") === undefined && Object.getOwnPropertyDescriptor(rest, "schema") === undefined) {
      defaultAdmins.set(client, { target: origin, from: client.from, schema: client.schema,
        prototype, rest, restTarget: `${origin}/rest/v1`, restSchema: "public", restDescriptor, restPrototype,
        restFrom, restSchemaMethod, restFetch, restUrl, restSchemaName });
    }
  }
  return client;
}
