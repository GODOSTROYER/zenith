/**
 * A stand-in for `nodemailer`, loaded through the same seam the real one is
 * (`NODEMAILER.spec`). It exists because the email path must be provable
 * without an SMTP server and without the package installed — `vi.mock` cannot
 * intercept a specifier that does not resolve on disk.
 *
 * Every message it "sends" is pushed onto `globalThis.__zenithFakeMail`.
 */
export function createTransport(url) {
  return {
    url,
    async sendMail(message) {
      (globalThis.__zenithFakeMail ??= []).push(message);
      return { messageId: "fake" };
    },
    close() {},
  };
}

// Named, because the lint rule flags an anonymous default export — and because
// the loader has to find `createTransport` on either shape.
const nodemailer = { createTransport };
export default nodemailer;
