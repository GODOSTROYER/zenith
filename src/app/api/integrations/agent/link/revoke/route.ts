/**
 * `POST /api/integrations/agent/link/revoke` — withdraw a linked credential.
 *
 * Effective on that credential's next request: nothing caches a verified token,
 * so there is nothing to invalidate.
 */
export { browserLinkRevoke as POST } from '@/lib/agent-access/control/browser';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
