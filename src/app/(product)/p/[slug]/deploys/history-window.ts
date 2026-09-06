import type { DeploymentPage } from "./status";

/** Re-read through the loaded window so a refresh never drops older selection. */
export async function readHistoryWindow(base: string, previousCount: number, previousTotal: number, read: (url: string) => Promise<DeploymentPage>, current: () => boolean): Promise<DeploymentPage | undefined> {
  let page = await read(base);
  let deployments = page.deployments;
  const keep = previousCount > 0 ? previousCount + Math.max(0, page.total - previousTotal) : 0;
  while (page.nextCursor && deployments.length < keep) {
    if (!current()) return undefined;
    page = await read(`${base}&cursor=${encodeURIComponent(page.nextCursor)}`);
    deployments = [...deployments, ...page.deployments];
  }
  return current() ? { ...page, deployments: [...new Map(deployments.map((d) => [d.id, d])).values()] } : undefined;
}
