/**
 * A stand-in for `nodemailer` whose transport always refuses, loaded through
 * the same seam the real one is (`NODEMAILER.spec`). It proves the failure path
 * end to end — every attempt recorded, the reason kept — without an SMTP server
 * that has to be persuaded to reject something.
 *
 * Every attempt it refuses is counted on `globalThis.__zenithFailedMail`.
 */
export function createTransport(url) {
  return {
    url,
    async sendMail() {
      globalThis.__zenithFailedMail = (globalThis.__zenithFailedMail ?? 0) + 1;
      throw new Error("550 the SMTP server rejected the recipient address");
    },
    close() {},
  };
}

// Named, because the lint rule flags an anonymous default export — and because
// the loader has to find `createTransport` on either shape.
const nodemailer = { createTransport };
export default nodemailer;
