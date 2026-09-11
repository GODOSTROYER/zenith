/**
 * Getting the invitation in front of the person — and being honest when that
 * cannot be done.
 *
 * Three outcomes, and none of them is "probably sent":
 *
 *  - No transport configured: the delivery row is born settled `failed`, with a
 *    reason that names `ORRERY_SMTP_URL`, and nothing is queued. The owner
 *    still has the link from the create response.
 *  - A transport that accepts: the outbox drains, the row says `sent` via
 *    `smtp` with the provider's id, and the sealed token is erased — so the
 *    database no longer holds anything that can be turned back into a link.
 *  - A transport that refuses: attempts are counted, the reason is on the row,
 *    and nothing anywhere claims success.
 *
 * The seal itself is checked directly: opened with the right invitation id,
 * refused with any other, and never containing the token in clear.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedDataDir, removeDir } from "../_fixtures";

const dataDir = isolatedDataDir("zenith-access-delivery-");
process.env.ORRERY_SECRET_KEY = "2".repeat(64);

const { closeAuthority, flushOutbox, openAuthority } = await import("@/lib/hosted/authority");
const {
  NODEMAILER,
  createInvite,
  inviteEmailProblem,
  registerAccessOutboxHandlers,
  sealInvite,
  unsealInvite,
} = await import("@/lib/hosted/access");
const { IDENTITIES, seedApp, seedGrant, uuid } = await import("./_helpers");

const a = openAuthority();
registerAccessOutboxHandlers();

const REAL_SPEC = NODEMAILER.spec;
const WORKING = new URL("../../alerts/fake-nodemailer.mjs", import.meta.url).href;
const FAILING = new URL("./failing-nodemailer.mjs", import.meta.url).href;

interface FakeMail {
  from: string;
  to: string;
  subject: string;
  text: string;
}
type MailGlobal = typeof globalThis & { __orreryFakeMail?: FakeMail[]; __zenithFailedMail?: number };

beforeEach(() => {
  (globalThis as MailGlobal).__orreryFakeMail = [];
  (globalThis as MailGlobal).__zenithFailedMail = 0;
});

afterEach(() => {
  NODEMAILER.spec = REAL_SPEC;
  delete process.env.ORRERY_SMTP_URL;
  delete process.env.ORRERY_ALERT_FROM;
  delete process.env.ZENITH_INVITE_FROM;
});

afterAll(() => {
  closeAuthority();
  removeDir(dataDir);
});

const withSmtp = (): void => {
  process.env.ORRERY_SMTP_URL = "smtp://user:pass@smtp.example.test:587";
  process.env.ORRERY_ALERT_FROM = "Zenith <zenith@example.test>";
};

const app = (slug: string) => {
  const record = seedApp(a, { slug, name: `App ${slug}` });
  seedGrant(a, record.id, IDENTITIES.owner, "owner");
  return record;
};

const invite = (appId: string) =>
  createInvite(appId, { email: IDENTITIES.stranger.email, role: "viewer" }, IDENTITIES.owner.subject);

const sealedBytes = (deliveryId: string): Uint8Array | null => {
  const row = a.db.prepare("SELECT sealed_payload FROM invite_deliveries WHERE id = ?").get(deliveryId);
  const value = row?.sealed_payload;
  return value instanceof Uint8Array ? value : null;
};

describe("with no transport configured", () => {
  it("settles the delivery failed at creation, names the variable, and queues nothing", () => {
    expect(inviteEmailProblem()).toContain("ORRERY_SMTP_URL");
    const target = app("delivery-none");
    const issued = invite(target.id);

    expect(issued.delivery.state).toBe("failed");
    expect(issued.delivery.settledAt).toBeTruthy();
    expect(issued.delivery.error).toContain("ORRERY_SMTP_URL");
    // The contract's word for this is `transport: "none"`; the v1 schema's CHECK
    // constraint does not list it yet (see the integrator request), so the
    // column is NULL until that migration lands. Either way the row must not
    // claim a transport it never used.
    expect(issued.delivery.transport === undefined || issued.delivery.transport === "none").toBe(true);
    expect(sealedBytes(issued.delivery.id)).toBeNull();
    expect(a.repos.outbox.getByKey(`invite:${issued.invite.id}:${issued.delivery.id}`)).toBeNull();

    // …and the owner still holds a working link.
    expect(issued.acceptUrl).toContain("token=");
  });
});

describe("with a transport that accepts", () => {
  it("drains the outbox, records what was sent, and erases the sealed token", async () => {
    withSmtp();
    NODEMAILER.spec = WORKING;
    const target = app("delivery-sent");
    const issued = invite(target.id);

    expect(issued.delivery.state).toBe("pending");
    expect(sealedBytes(issued.delivery.id)).toBeInstanceOf(Uint8Array);
    const queued = a.repos.outbox.getByKey(`invite:${issued.invite.id}:${issued.delivery.id}`);
    expect(queued).toMatchObject({ kind: "invite_email", state: "pending" });

    const drained = await flushOutbox({ kinds: ["invite_email"] });
    expect(drained).toMatchObject({ done: 1, failed: 0 });

    expect(a.repos.deliveries.get(issued.delivery.id)).toMatchObject({
      state: "sent",
      transport: "smtp",
      providerMessageId: "fake",
      error: undefined,
    });
    expect(sealedBytes(issued.delivery.id)).toBeNull();
    expect(a.repos.outbox.get(queued!.id)?.state).toBe("done");

    const sent = (globalThis as MailGlobal).__orreryFakeMail ?? [];
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(IDENTITIES.stranger.email);
    expect(sent[0].from).toBe("Zenith <zenith@example.test>");
    expect(sent[0].subject).toContain(target.name);
    expect(sent[0].text).toContain(issued.acceptUrl);
    expect(sent[0].text).toContain("48 hours");
  });

  it("prefers ZENITH_INVITE_FROM over the alert address", async () => {
    withSmtp();
    process.env.ZENITH_INVITE_FROM = "Invitations <invites@example.test>";
    NODEMAILER.spec = WORKING;
    const target = app("delivery-from");
    invite(target.id);

    await flushOutbox({ kinds: ["invite_email"] });
    const sent = (globalThis as MailGlobal).__orreryFakeMail ?? [];
    expect(sent[0].from).toBe("Invitations <invites@example.test>");
  });

  it("does not send for an invitation that stopped being outstanding", async () => {
    withSmtp();
    NODEMAILER.spec = WORKING;
    const target = app("delivery-superseded");
    const first = invite(target.id);
    // A resend supersedes the first invitation before its email went out.
    invite(target.id);

    await flushOutbox({ kinds: ["invite_email"] });
    const sent = (globalThis as MailGlobal).__orreryFakeMail ?? [];
    expect(sent).toHaveLength(1);
    expect(a.repos.deliveries.get(first.delivery.id)).toMatchObject({ state: "failed" });
    expect(a.repos.deliveries.get(first.delivery.id)?.error).toContain("superseded");
  });
});

describe("with a transport that refuses", () => {
  it("records the failure with its reason, after every attempt, and claims nothing", async () => {
    withSmtp();
    NODEMAILER.spec = FAILING;
    const target = app("delivery-failed");
    const issued = invite(target.id);

    const drained = await flushOutbox({ kinds: ["invite_email"] });
    expect(drained).toMatchObject({ done: 0, failed: 1 });

    const delivery = a.repos.deliveries.get(issued.delivery.id);
    expect(delivery?.state).toBe("failed");
    expect(delivery?.error).toContain("rejected the recipient address");
    expect(delivery?.attempts).toBeGreaterThan(1);

    const entry = a.repos.outbox.getByKey(`invite:${issued.invite.id}:${issued.delivery.id}`);
    expect(entry?.state).toBe("failed");
    expect(entry?.error).toContain("rejected the recipient address");
    expect((globalThis as MailGlobal).__zenithFailedMail).toBeGreaterThan(1);
  });
});

describe("the sealed payload", () => {
  it("never holds the token in clear, and refuses to open under another invitation id", () => {
    const inviteId = uuid();
    const payload = {
      token: `token-${uuid()}`,
      email: IDENTITIES.stranger.email,
      appName: "App sealed",
      acceptUrl: "http://localhost:3400/apps/accept?token=x",
    };
    const sealed = sealInvite(inviteId, payload);

    expect(Buffer.from(sealed).includes(Buffer.from(payload.token, "utf8"))).toBe(false);
    expect(unsealInvite(inviteId, sealed)).toEqual(payload);

    // Tampering with the AAD, and with the ciphertext, both refuse.
    expect(() => unsealInvite(uuid(), sealed)).toThrow(/could not be opened/);
    const altered = new Uint8Array(sealed);
    altered[altered.length - 1] ^= 0xff;
    expect(() => unsealInvite(inviteId, altered)).toThrow(/could not be opened/);
  });

  it("cannot be opened by a server holding a different key", () => {
    const inviteId = uuid();
    const sealed = sealInvite(inviteId, {
      token: `token-${uuid()}`,
      email: IDENTITIES.stranger.email,
      appName: "App other key",
      acceptUrl: "http://localhost:3400/apps/accept?token=x",
    });

    const ours = process.env.ORRERY_SECRET_KEY;
    process.env.ORRERY_SECRET_KEY = "9".repeat(64);
    try {
      expect(() => unsealInvite(inviteId, sealed)).toThrow(/could not be opened/);
    } finally {
      process.env.ORRERY_SECRET_KEY = ours;
    }
    expect(unsealInvite(inviteId, sealed).appName).toBe("App other key");
  });
});
