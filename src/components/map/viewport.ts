export const MAP_MIN_ZOOM = 0.1;
export const MAP_MAX_ZOOM = 1.6;

/** Match D3's double-click gesture while keeping the point under the pointer fixed. */
export function doubleClickViewport(
  current: { x: number; y: number; zoom: number },
  pointer: { x: number; y: number },
  zoomOut: boolean
): { x: number; y: number; zoom: number } {
  const zoom = Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, current.zoom * (zoomOut ? 0.5 : 2)));
  const ratio = zoom / current.zoom;
  return { x: pointer.x - (pointer.x - current.x) * ratio, y: pointer.y - (pointer.y - current.y) * ratio, zoom };
}
