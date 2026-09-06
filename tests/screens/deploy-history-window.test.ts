import { expect, it } from "vitest";
import type { Deployment } from "@/lib/domain/types";
import { readHistoryWindow } from "@/app/(product)/p/[slug]/deploys/history-window";

it("keeps the previous oldest deployment after a new deployment moves offset cursors", async () => {
  const all = Array.from({ length: 121 }, (_, i) => ({ id: `d${121 - i}` } as Deployment));
  const page = await readHistoryWindow("/history?limit=50", 100, 120, async (url) => {
    const offset = Number(new URL(url, "http://local.test").searchParams.get("cursor") ?? 0);
    return { deployments: all.slice(offset, offset + 50), total: 121, nextCursor: offset + 50 < 121 ? String(offset + 50) : undefined };
  }, () => true);
  expect(page?.deployments.some((d) => d.id === "d21")).toBe(true);
  expect(page?.deployments[0].id).toBe("d121");
  expect(new Set(page?.deployments.map((d) => d.id)).size).toBe(page?.deployments.length);
});

it("discards a history response after its environment changes", async () => {
  const page = await readHistoryWindow("/history?limit=50", 0, 0, async () => ({ deployments: [{ id: "old-env" } as Deployment], total: 1 }), () => false);
  expect(page).toBeUndefined();
});
