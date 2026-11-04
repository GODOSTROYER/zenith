/**
 * Real PGlite writes, with synthetic canaries (not a real Postgres/network run).
 * Repositories reject recognizable shapes; they do not redact arbitrary values.
 * Characterizations record that distinction rather than asserting the handoff's
 * unverified claim that these repositories have no secret-value checks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as events from "@/lib/controlplane/db/repos/events";
import * as evidence from "@/lib/controlplane/db/repos/evidence";
import { assertNoCanaries, canarySecret, deepScanForCanaries } from "../_support/security";
import { CANARY_SHAPES } from "../_support/security/canaries";

let db: PlatformDbHandle;
beforeAll(async () => { db = await openPlatformDb({ kind: "pglite" }); }, 60_000);
afterAll(async () => { await db?.close(); });
const ws = "security-store-canaries";

describe("events and evidence secret-value characterization", () => {
  it("rejects recognized credential shapes and preserves unrecognized opaque values without scrubbing", async () => {
    const refused = new Set(["aws-access-key-id", "github-token", "slack-token", "pem-private-key", "jwt"]);
    for (const shape of CANARY_SHAPES) {
      const canary = canarySecret(`store/${shape}`, shape, { stable: true });
      const writes = [
        () => events.append(db, { workspaceId: ws, type: "operation.started", correlationId: `security-${shape}`, data: { diagnostic: canary } }),
        () => evidence.insert(db, { workspaceId: ws, kind: "http_probe", digest: "a".repeat(64), simulated: false, summary: { diagnostic: canary } }),
      ];
      for (const write of writes) {
        if (refused.has(shape)) {
          const error: unknown = await write().catch((e: unknown) => e);
          expect(error, `store must reject recognized ${shape} before writing`).toMatchObject({ code: "secret_material" });
          assertNoCanaries(error, [canary], "store refusal must name only the field, never its secret value");
        } else {
          await write();
        }
      }
      const stored = [await events.list(db, ws, { correlationId: `security-${shape}` }), await evidence.list(db, ws)];
      if (refused.has(shape)) assertNoCanaries(stored, [canary], "refused secret shapes must not be persisted");
      else for (const surface of stored) expect(deepScanForCanaries(surface, [canary]).length, `${shape} is a documented heuristic gap on EACH repository surface, not automatically scrubbed`).toBeGreaterThan(0);
    }
    expect(await events.list(db, "foreign-workspace")).toEqual([]);
    expect(await evidence.list(db, "foreign-workspace")).toEqual([]);
  });
});
