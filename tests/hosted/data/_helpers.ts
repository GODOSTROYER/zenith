/**
 * Shared helpers for the W3 data tests. Not a test file — vitest only collects
 * `*.test.ts`.
 */
import type { DataContext, EquipmentRequestInput } from "@/lib/hosted/contracts";
import { IDENTITIES, type TestIdentity } from "../_fixtures";

/** Two app ids that never collide, mirroring the two-app fixture. */
export const APP_A = "app-alpha";
/** The second app, used to prove records never cross between databases. */
export const APP_B = "app-beta";

/** The release id every test context claims to have been served by. */
export const RELEASE_ID = "rel-0000000000000001";

/** Builds a `DataContext` for one of the standard identities. */
export function ctx(
  role: DataContext["role"],
  identity: TestIdentity = IDENTITIES.editor,
  appId: string = APP_A
): DataContext {
  return { appId, subject: identity.subject, email: identity.email, role, releaseId: RELEASE_ID };
}

/** A context whose role is not one this app grants — what a stranger would carry. */
export function strangerCtx(appId: string = APP_A): DataContext {
  return {
    appId,
    subject: IDENTITIES.stranger.subject,
    email: IDENTITIES.stranger.email,
    role: "stranger" as DataContext["role"],
    releaseId: RELEASE_ID,
  };
}

/** A valid equipment-request input with the given overrides applied. */
export function input(overrides: Partial<EquipmentRequestInput> = {}): EquipmentRequestInput {
  return {
    title: "Standing desk",
    details: "Adjustable, 160cm",
    category: "furniture",
    quantity: 1,
    priority: "normal",
    status: "requested",
    requestedFor: "Sam Rivera",
    neededBy: "2026-10-01",
    ...overrides,
  };
}

/**
 * A deliberately invalid record body, cast so it reaches the store's own
 * validation instead of being stopped by the compiler. The point of these
 * cases is that the runtime refuses them — a caller sending raw JSON has no
 * compiler in the way either.
 */
export function badInput(overrides: Record<string, unknown>): EquipmentRequestInput {
  return { ...input(), ...overrides } as unknown as EquipmentRequestInput;
}

/**
 * Blocks until `Date.now()` reports a different millisecond.
 *
 * `created_at` has millisecond resolution, so two records written inside one
 * millisecond tie and are ordered by id instead of by insertion. Tests that
 * assert "newest first" separate their writes with this rather than pretending
 * the tie does not exist. Costs at most one clock tick (about 1–16 ms on
 * Windows).
 */
export function nextMillisecond(): void {
  const start = Date.now();
  while (Date.now() === start) {
    /* spin: a timer would not guarantee the clock advanced */
  }
}
