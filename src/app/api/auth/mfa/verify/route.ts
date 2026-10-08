/** Recheck the cookie session on the server after Supabase promotes it to AAL2. */
import { route } from "@/lib/server/request";
export const dynamic = "force-dynamic";
export const POST = route(async () => ({ verified: true }));
// Read-only maintenance must not prevent an operator completing step-up to lift maintenance.
export const GET = route(async () => ({ verified: true }));
