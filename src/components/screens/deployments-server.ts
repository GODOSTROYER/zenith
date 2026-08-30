"use server";
/**
 * There is no `GET /api/environments/:id/deployments` yet — `/api/bootstrap`
 * only carries the latest deployment per environment. This server action reads
 * the same store the API does so the Deploys screen can show real history.
 *
 * ponytail: replace with the REST route the moment workstream D adds one; the
 * call site is a single `listDeployments(envId)`.
 */
import { q } from "@/lib/db/store";
import type { Deployment } from "@/lib/domain/types";

export async function listDeployments(environmentId: string): Promise<Deployment[]> {
  if (!environmentId) return [];
  return q.deploymentsOf(environmentId).slice(0, 50);
}
