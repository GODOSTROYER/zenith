/**
 * An in-memory stand-in for the fixed broker, good enough to drive the real
 * screen: list with a cursor and filters, read, create with write-id replay,
 * and update with record versions and a 409 that carries the current record.
 *
 * It is deliberately strict about the things the app must get right - a
 * mutation without a write id, or an update without an expected version, is
 * refused here exactly as the contract says it would be.
 *
 * Not a test file: helper for app.test.tsx.
 *
 * Workstream W4 (hosted R3)
 */
import type {
  EquipmentRequest,
  EquipmentRequestInput,
  EquipmentRequestPatch,
  SessionInfo,
  SessionRole,
} from "../../../fixtures/tracker-app/src/api";

export interface BrokerCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

export interface Broker {
  fetch: (path: string, init: RequestInit) => Promise<Response>;
  calls: BrokerCall[];
  /** every write id the broker was sent, in order */
  writeIds: string[];
  records: EquipmentRequest[];
  session: SessionInfo;
  /** hold the next mutation until the returned function is called */
  hold: () => () => void;
  /** answer the next `times` matching requests with this refusal instead */
  refuseNext: (
    match: RegExp,
    status: number,
    code: string,
    message: string,
    times?: number
  ) => void;
  /** somebody else changes a record behind the app's back */
  editElsewhere: (id: string, patch: EquipmentRequestPatch, byEmail?: string) => EquipmentRequest;
}

export interface BrokerOptions {
  role?: SessionRole;
  seed?: EquipmentRequest[];
  pageSize?: number;
}

const CLOCK_START = Date.UTC(2026, 8, 1, 9, 0, 0);

export function seedRecord(
  index: number,
  overrides: Partial<EquipmentRequest> = {}
): EquipmentRequest {
  const at = new Date(CLOCK_START + index * 3_600_000).toISOString();
  const base: EquipmentRequestInput = {
    title: `Request ${index}`,
    details: "",
    category: "laptop",
    quantity: 1,
    priority: "normal",
    status: "requested",
    requestedFor: "",
    neededBy: null,
  };
  return {
    ...base,
    id: `req-${index}`,
    version: 1,
    createdBy: "sub-owner",
    createdByEmail: "owner@example.test",
    createdAt: at,
    updatedBy: "sub-owner",
    updatedByEmail: "owner@example.test",
    updatedAt: at,
    ...overrides,
  };
}

const body = (init: RequestInit): Record<string, unknown> | null =>
  typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

const refuse = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): Response => json(status, { error: { code, message, details } });

export function makeBroker(options: BrokerOptions = {}): Broker {
  const role: SessionRole = options.role ?? "editor";
  const pageSize = options.pageSize ?? 25;
  const records: EquipmentRequest[] = [...(options.seed ?? [])];
  const calls: BrokerCall[] = [];
  const writeIds: string[] = [];
  const replay = new Map<string, EquipmentRequest>();
  let held: { release: () => void; gate: Promise<void> } | null = null;
  let queued: { match: RegExp; status: number; code: string; message: string; left: number } | null =
    null;
  let clock = CLOCK_START + 10 * 3_600_000;

  const session: SessionInfo = {
    subject: "sub-owner",
    email: role === "viewer" ? "vi@example.test" : "owner@example.test",
    role,
    app: { id: "app-1", slug: "equipment", name: "Equipment requests" },
    releaseId: "rel_2026090701",
    schemaVersion: 1,
    limits: { listMax: 100, bodyBytes: 1_048_576 },
    expiresAt: "2026-09-08T09:00:00.000Z",
  };

  const stamp = (): string => {
    clock += 60_000;
    return new Date(clock).toISOString();
  };

  const newest = (): EquipmentRequest[] =>
    [...records].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  const canWrite = role === "owner" || role === "editor";

  async function handle(path: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const parsed = body(init);
    calls.push({ method, path, body: parsed });

    if (queued && queued.match.test(path)) {
      const { status, code, message } = queued;
      queued.left -= 1;
      if (queued.left <= 0) queued = null;
      return refuse(status, code, message);
    }

    if (path === "/_zenith/session") return json(200, session);
    if (path === "/_zenith/auth/signout") return new Response(null, { status: 204 });

    const url = new URL(path, "https://equipment.apps.localhost");
    const rest = url.pathname.replace("/_zenith/data/v1/requests", "");

    if (method === "GET" && rest === "") {
      const status = url.searchParams.get("status");
      const category = url.searchParams.get("category");
      const limit = Number(url.searchParams.get("limit") ?? pageSize);
      const offset = Number(url.searchParams.get("cursor") ?? "0");
      const matching = newest().filter(
        (item) => (!status || item.status === status) && (!category || item.category === category)
      );
      const page = matching.slice(offset, offset + limit);
      const next = offset + limit < matching.length ? String(offset + limit) : undefined;
      return json(200, { items: page, nextCursor: next });
    }

    if (method === "GET") {
      const found = records.find((item) => item.id === rest.slice(1));
      return found
        ? json(200, { record: found })
        : refuse(404, "not_found", "That request no longer exists.");
    }

    if (held) await held.gate;
    if (!canWrite) return refuse(403, "forbidden", "Viewers cannot change requests.");

    const writeId = typeof parsed?.writeId === "string" ? parsed.writeId : null;
    if (!writeId) return refuse(400, "invalid_input", "A write id is required.");
    writeIds.push(writeId);
    const replayed = replay.get(writeId);
    if (replayed) return json(method === "POST" ? 201 : 200, { record: replayed });

    if (method === "POST") {
      const input = parsed?.record as EquipmentRequestInput;
      const at = stamp();
      const created: EquipmentRequest = {
        ...input,
        id: `req-new-${records.length + 1}`,
        version: 1,
        createdBy: session.subject,
        createdByEmail: session.email,
        createdAt: at,
        updatedBy: session.subject,
        updatedByEmail: session.email,
        updatedAt: at,
      };
      records.push(created);
      replay.set(writeId, created);
      return json(201, { record: created });
    }

    const id = rest.slice(1);
    const index = records.findIndex((item) => item.id === id);
    if (index < 0) return refuse(404, "not_found", "That request no longer exists.");
    const current = records[index];
    const expected = parsed?.expectedVersion;
    if (typeof expected !== "number") {
      return refuse(400, "invalid_input", "An expected version is required.");
    }
    if (expected !== current.version) {
      return refuse(409, "stale_version", "Someone changed this first.", {
        expectedVersion: expected,
        current,
      });
    }
    const updated: EquipmentRequest = {
      ...current,
      ...(parsed?.patch as EquipmentRequestPatch),
      version: current.version + 1,
      updatedBy: session.subject,
      updatedByEmail: session.email,
      updatedAt: stamp(),
    };
    records[index] = updated;
    replay.set(writeId, updated);
    return json(200, { record: updated });
  }

  return {
    fetch: handle,
    calls,
    writeIds,
    records,
    session,
    hold: () => {
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = () => {
          held = null;
          resolve();
        };
      });
      held = { release, gate };
      return release;
    },
    refuseNext: (match, status, code, message, times = 1) => {
      queued = { match, status, code, message, left: times };
    },
    editElsewhere: (id, patch, byEmail = "ed@example.test") => {
      const index = records.findIndex((item) => item.id === id);
      const updated: EquipmentRequest = {
        ...records[index],
        ...patch,
        version: records[index].version + 1,
        updatedBy: "sub-editor",
        updatedByEmail: byEmail,
        updatedAt: stamp(),
      };
      records[index] = updated;
      return updated;
    },
  };
}
