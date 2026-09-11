/**
 * Take your data with you.
 *
 *   GET /api/account/export → a JSON attachment
 *
 * Served as a download rather than a rendered page: this is a file somebody
 * keeps, not a screen they read. What is in it — and what is deliberately not —
 * is `buildAccountExport` in `server/account.ts`, including the `notes` array
 * the file itself carries so the answer travels with the export.
 */
import { accountExportFilename, buildAccountExport, requireAccountUser } from "@/lib/server/account";
import { route } from "@/lib/server/context";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = requireAccountUser();
  const body = buildAccountExport(user);
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${accountExportFilename(user)}"`,
      "cache-control": "no-store",
    },
  });
});
