/**
 * `GET /api/integrations/agent/link?code=…` — what the approval screen reads.
 *
 * Browser-only: the shared `browser()` helper refuses a request carrying an
 * `authorization` header, verifies the session against the identity provider on
 * every call, and requires a live workspace member row.
 */
export { browserLinkGet as GET } from '@/lib/agent-access/control/browser';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
