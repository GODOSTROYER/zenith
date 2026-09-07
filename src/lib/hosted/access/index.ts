/**
 * App access — grants, invitations, exchanges and app sessions.
 *
 * The barrel every other workstream imports (`@/lib/hosted/access`). The
 * signatures here are the ones the integrator's stub published and W6, W7 and
 * the boot path already code against; this file may gain exports, never change
 * one.
 *
 * What lives behind it:
 *
 *   grants.ts    — the only authority on who may open an app (R3-02, G10)
 *   invites.ts   — hashed single-use links, sealed delivery, the outbox handler (G11)
 *   sessions.ts  — exchange codes, opaque app sessions, the `__Host-` cookie (R3-09, G12)
 *   identity.ts  — the live `getUser()` check; unavailable is never a pass (R3-10, G13)
 *   seal.ts      — AES-256-GCM over the one value that cannot be stored in clear
 *   mail.ts      — the nodemailer seam, and honesty about "sent"
 *
 * `http.ts` (the /api layer for these routes) is intentionally not re-exported:
 * the gateway and the job runner import this barrel and have no business
 * pulling the request layer in behind it.
 *
 * Workstream W5 (hosted R3).
 */

export {
  activeGrant,
  changeGrantRole,
  grantDirect,
  listGrants,
  requireAppRole,
  revokeGrant,
  type DirectGrant,
  type GrantScope,
  type RevokedGrant,
} from "./grants";

export {
  INVITE_EMAIL_KIND,
  acceptInvite,
  createInvite,
  inviteAcceptUrl,
  listInvites,
  registerAccessOutboxHandlers,
  resendInvite,
  revokeInvite,
  scheduleInviteDelivery,
  type AcceptedInvite,
  type InviteScope,
  type IssuedInvite,
  type NewInviteInput,
} from "./invites";

export {
  EXCHANGE_STATE_MAX,
  EXCHANGE_STATE_MIN,
  appSessionCookie,
  clearAppSessionCookie,
  createExchange,
  redeemExchange,
  resolveAppSession,
  resolveAppSessionDetailed,
  terminateAppSession,
  terminateAppSessionsForApp,
  terminateAppSessionsForSubject,
  type AppSessionDenial,
  type ExchangeRedirect,
  type RedeemOptions,
  type RedeemedExchange,
  type ResolvedAppSession,
} from "./sessions";

export {
  NO_IDENTITY_PROVIDER,
  sessionAuthority,
  setSessionAuthorityForTests,
  supabaseSessionAuthority,
  verifyRequestIdentity,
  type IdentityClient,
  type IdentityClientFactory,
  type ProviderError,
  type ProviderUser,
  type RequestIdentityAuthority,
} from "./identity";

export {
  NO_SECRET_KEY,
  sealInvite,
  sealingConfigured,
  unsealInvite,
  type SealedInvite,
} from "./seal";

export {
  INVITE_SEND_TIMEOUT_MS,
  INVITE_TTL_HOURS,
  MISSING_NODEMAILER,
  NODEMAILER,
  inviteEmailProblem,
  inviteFrom,
  inviteMessage,
  sendInviteEmail,
} from "./mail";
