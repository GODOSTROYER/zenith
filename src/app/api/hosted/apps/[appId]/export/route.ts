/**
 * `GET /api/hosted/apps/:appId/export` — the app's own data, as a file.
 *
 * Owner only, checked live against the control authority. Served with download
 * headers and `no-store`: this document holds every equipment request in the
 * app, so it must not sit in a shared cache, and it should land in the user's
 * downloads rather than render in a tab.
 *
 * Workstream W8 (hosted R3).
 */
import { NextResponse } from "next/server";
import { exportApp } from "@/lib/hosted/export";
import { route } from "@/lib/server/context";
import { hosted, requireAppOwner } from "@/app/api/hosted/ops/_http";

export const dynamic = "force-dynamic";

export const GET = route<{ appId: string }>(async (_req, { appId }) =>
  hosted(async () => {
    const caller = requireAppOwner(appId);
    const bundle = await exportApp(appId, { subject: caller.subject, email: caller.email });
    const filename = `zenith-${bundle.app.slug}-${bundle.exportedAt.slice(0, 10)}.json`;
    return new NextResponse(`${JSON.stringify(bundle, null, 2)}\n`, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  })
);
