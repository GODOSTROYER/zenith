import { redirect } from "next/navigation";
import { db } from "@/lib/db/store";
import { ensureBoot } from "@/lib/server/boot";

export const dynamic = "force-dynamic";

/** Product entry: straight to the workspace, or into onboarding if there isn't one. */
export default async function Entry() {
  await ensureBoot();
  redirect(db().workspaces.length > 0 ? "/overview" : "/onboarding");
}
