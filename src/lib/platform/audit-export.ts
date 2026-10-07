/**
 * Composition root for signed audit exports (PROD-OPS-09): the platform control store, the control-plane signer
 * (`signing:jobs`) and the product audit reader (Postgres or file store, whichever is active).
 */
import { platformDb } from "@/lib/controlplane/db";
import { getControlSigner } from "@/lib/credentials";
import { createAuditExport, type AuditExportDocument, type AuditReader } from "@/lib/audit-export/service";
import { listExports, type AuditExportRecord } from "@/lib/audit-export/store";
import { readAuditPageAsync } from "@/lib/db/store";
import { ensurePlatformApp } from "./app";

const productAuditReader: AuditReader = async (filter) => {
  const page = await readAuditPageAsync({ workspaceId: filter.workspaceId, from: filter.from, to: filter.to, limit: filter.limit, cursor: filter.cursor });
  return { events: page.events, nextCursor: page.nextCursor };
};

/** `null` when the platform store is not configured (the route answers with the standard unavailable error). */
export async function platformAuditExports(): Promise<{
  create(input: { workspaceId: string; createdBy: string; from?: string; to?: string }): Promise<{ document: AuditExportDocument; record: AuditExportRecord }>;
  list(workspaceId: string, limit?: number): Promise<AuditExportRecord[]>;
} | null> {
  if (!(await ensurePlatformApp())) return null;
  const db = await platformDb();
  return {
    create: async (input) => createAuditExport({ db, signer: await getControlSigner(), read: productAuditReader }, input),
    list: (workspaceId, limit) => listExports(db, workspaceId, limit),
  };
}
