import { describe, expect, it } from "vitest";
import { doubleClickViewport, MAP_MIN_ZOOM, MAP_MAX_ZOOM } from "@/components/map/viewport";

describe("reduced-motion double-click zoom", () => {
  it.each([false, true])("keeps the exact resource position beneath the pointer with zoomOut=%s", (zoomOut) => {
    const before = { x: -120, y: 48, zoom: 0.6 };
    const pointer = { x: 320, y: 210 };
    const after = doubleClickViewport(before, pointer, zoomOut);
    expect(after.zoom).toBe(before.zoom * (zoomOut ? 0.5 : 2));
    expect((pointer.x - after.x) / after.zoom).toBeCloseTo((pointer.x - before.x) / before.zoom);
    expect((pointer.y - after.y) / after.zoom).toBeCloseTo((pointer.y - before.y) / before.zoom);
  });
  it.each([[MAP_MAX_ZOOM, false], [MAP_MIN_ZOOM, true]] as const)("preserves the viewport at its %s zoom limit", (zoom, zoomOut) => {
    const before = { x: -24, y: 16, zoom };
    expect(doubleClickViewport(before, { x: 120, y: 160 }, zoomOut)).toEqual(before);
  });
});
