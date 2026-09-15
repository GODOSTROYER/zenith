/**
 * `POST /api/integrations/agent/link/approve` — the consent itself.
 *
 * A mutation, so it additionally requires the request's `origin` to be the
 * configured Zenith origin. The issued secret is deliberately not in this
 * response: the terminal collects it over the channel bound to its device code.
 */
export { browserLinkApprove as POST } from '@/lib/agent-access/control/browser';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
