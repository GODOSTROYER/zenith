/**
 * Putting an invitation in front of a person — and being honest about when it
 * cannot be done.
 *
 * `nodemailer` is loaded through a non-literal specifier held in an object, the
 * same seam `src/lib/alerts/deliver.ts` uses. Two reasons, both load-bearing:
 * `tsc` and the bundler must not resolve the package at build time, and a test
 * must be able to point the seam at a stand-in to prove the send path without
 * an SMTP server. The pattern is copied rather than imported — the alert
 * deliverer owns alert channels, and app invitations are not one.
 *
 * "Sent" here means one thing only: the SMTP server accepted the message.
 * Nothing in this file ever claims a mailbox received it.
 */
import { INVITE_TTL_MS } from "@/lib/hosted/contracts";
import { hostedConfig } from "@/lib/hosted/config";
import { SECRET_KEY_FIX, SMTP_FIX, env } from "@/lib/env";
import { withTimeout } from "@/lib/timeout";
import { NO_SECRET_KEY, sealingConfigured, type SealedInvite } from "./seal";

interface MailTransport {
  sendMail(m: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<{ messageId?: string } | unknown>;
  close?(): void;
}

interface NodemailerLike {
  createTransport(url: string): MailTransport;
}

export const MISSING_NODEMAILER =
  "The nodemailer package is not installed, so invitation email cannot be sent. Run `npm install` in the Zenith repo (nodemailer is in package.json) and restart the server. The invitation itself was created — copy its link and send it by hand.";

/**
 * The module specifier, in an object so a test can point it at a stand-in and
 * prove both the send and the missing-package refusal. Not a literal at the
 * import site on purpose.
 */
export const NODEMAILER = { spec: "nodemailer" };

/** How long one SMTP handshake-plus-send may take before it is abandoned. */
export const INVITE_SEND_TIMEOUT_MS = 15_000;

async function loadNodemailer(): Promise<NodemailerLike> {
  let mod: unknown;
  try {
    mod = await import(/* webpackIgnore: true */ NODEMAILER.spec);
  } catch {
    throw new Error(MISSING_NODEMAILER);
  }
  // CJS through an ESM import lands on `default` in some runtimes and on the
  // namespace in others. Take whichever one actually has the function.
  const m = mod as Partial<NodemailerLike> & { default?: Partial<NodemailerLike> };
  const ns = typeof m.createTransport === "function" ? m : m.default;
  if (!ns || typeof ns.createTransport !== "function") throw new Error(MISSING_NODEMAILER);
  return ns as NodemailerLike;
}

/** The From address invitations are sent from, or undefined when none is configured. */
export function inviteFrom(): string | undefined {
  const from = hostedConfig().ZENITH_INVITE_FROM ?? env().ORRERY_ALERT_FROM;
  return from && from.trim() ? from.trim() : undefined;
}

/**
 * Why an invitation email cannot be attempted right now, or undefined when it
 * can. Read **before** the invitation is created, so the delivery row can be
 * born settled rather than queued for an effect this install cannot perform.
 */
export function inviteEmailProblem(): string | undefined {
  if (!sealingConfigured()) return `${NO_SECRET_KEY} ${SECRET_KEY_FIX}`;
  if (!env().ORRERY_SMTP_URL)
    return `No SMTP server is configured, so this invitation could not be emailed. ${SMTP_FIX}`;
  if (!inviteFrom())
    return `ORRERY_SMTP_URL is set but neither ZENITH_INVITE_FROM nor ORRERY_ALERT_FROM is, so the invitation email would have no From address. ${SMTP_FIX}`;
  return undefined;
}

/** Hours an invitation stays usable, from the contract rather than from prose. */
export const INVITE_TTL_HOURS = Math.round(INVITE_TTL_MS / 3_600_000);

/** The plain-text invitation. One link, one deadline, nothing to click but the link. */
export function inviteMessage(payload: SealedInvite): { subject: string; text: string } {
  return {
    subject: `You have been invited to ${payload.appName} on Zenith`,
    text: [
      `You have been invited to ${payload.appName}.`,
      "",
      "Open this link, sign in with this address, and you are in:",
      payload.acceptUrl,
      "",
      `The link works once and expires ${INVITE_TTL_HOURS} hours after it was sent.`,
      `It only works for ${payload.email} — signing in as anyone else will refuse it.`,
      "",
      "Sent by Zenith. If you were not expecting this, ignore it; nothing happens until the link is opened.",
    ].join("\n"),
  };
}

/**
 * Hand the message to the configured SMTP server and answer with the provider's
 * message id when it gave one. Throws with a reason that names the variable to
 * fix; the caller records that reason on the delivery row.
 */
export async function sendInviteEmail(payload: SealedInvite): Promise<string | undefined> {
  const problem = inviteEmailProblem();
  if (problem) throw new Error(problem);
  const smtpUrl = env().ORRERY_SMTP_URL as string;
  const from = inviteFrom() as string;
  const nodemailer = await loadNodemailer();
  const transport = nodemailer.createTransport(smtpUrl);
  const { subject, text } = inviteMessage(payload);
  try {
    const result = await withTimeout(
      transport.sendMail({ from, to: payload.email, subject, text }),
      INVITE_SEND_TIMEOUT_MS,
      `The SMTP server did not accept the invitation within ${INVITE_SEND_TIMEOUT_MS / 1000}s. Check ORRERY_SMTP_URL — a wrong port is the usual cause.`
    );
    const id = (result as { messageId?: unknown })?.messageId;
    return typeof id === "string" ? id : undefined;
  } finally {
    transport.close?.();
  }
}
