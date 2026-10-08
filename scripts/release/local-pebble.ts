/** Real Pebble ACME HTTP-01 issuance against loopback and dedicated CoreDNS. No production CA. */
import { generateKeyPairSync, createHash, sign, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { command, waitFor } from "./local-environment";
import { loopbackUrl } from "./local-targets";

interface Response { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
export async function pebbleIssuance(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const apiOrigin = "https://127.0.0.1:14000";
  const ca = readFileSync(path.join(root, "pki/ca.crt"));
  async function request(raw: string, method = "GET", body?: string): Promise<Response> {
    const url = loopbackUrl(raw, raw.startsWith(apiOrigin) ? 14000 : 15000);
    if (url.protocol !== "https:") throw new Error("Pebble TLS required");
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method, ca, rejectUnauthorized: true, timeout: 10_000, headers: body ? { "content-type": "application/jose+json" } : {} }, res => {
        const chunks: Buffer[] = []; let bytes = 0;
        res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1_048_576) req.destroy(new Error("Pebble response too large")); else chunks.push(chunk); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("error", reject); req.on("timeout", () => req.destroy(new Error("Pebble timeout"))); req.end(body);
    });
  }
  const json = (response: Response): Record<string, unknown> => {
    if (response.status < 200 || response.status >= 300) throw new Error(`Pebble rejected request (${response.status})`);
    return JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
  };
  await waitFor(async () => (await request(`${apiOrigin}/dir`)).status === 200);
  const directory = json(await request(`${apiOrigin}/dir`));
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const exported = publicKey.export({ format: "jwk" });
  const jwk = { crv: exported.crv, kty: exported.kty, x: exported.x, y: exported.y };
  const thumbprint = createHash("sha256").update(JSON.stringify(jwk)).digest("base64url");
  let kid = "";
  async function signed(raw: string, payload: unknown | ""): Promise<Response> {
    if (new URL(raw).origin !== apiOrigin) throw new Error("Pebble directory named a foreign authority");
    // Retry ACME's deliberate badNonce rejection, bounded; no global validation bypass.
    for (let attempt = 0; attempt < 5; attempt++) {
      const nonce = (await request(String(directory.newNonce), "HEAD")).headers["replay-nonce"];
      if (typeof nonce !== "string") throw new Error("Missing ACME nonce");
      const protectedPart = Buffer.from(JSON.stringify({ alg: "ES256", nonce, url: raw, ...(kid ? { kid } : { jwk }) })).toString("base64url");
      const encoded = payload === "" ? "" : Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signature = sign("sha256", Buffer.from(`${protectedPart}.${encoded}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
      const response = await request(raw, "POST", JSON.stringify({ protected: protectedPart, payload: encoded, signature }));
      if (response.status === 400 && response.body.toString("utf8").includes("urn:ietf:params:acme:error:badNonce")) continue;
      return response;
    }
    throw new Error("Pebble nonce retries exhausted");
  }
  const account = await signed(String(directory.newAccount), { termsOfServiceAgreed: true });
  json(account); kid = String(account.headers.location ?? "");
  if (!kid) throw new Error("Missing ACME account location");
  const ordered = await signed(String(directory.newOrder), { identifiers: [{ type: "dns", value: "mixed.j15.test" }] });
  const order = json(ordered); const orderUrl = String(ordered.headers.location ?? "");
  if (!Array.isArray(order.authorizations) || order.authorizations.length !== 1) throw new Error("Unexpected ACME authorizations");
  const authorizationUrl = String(order.authorizations[0]);
  const authorization = json(await signed(authorizationUrl, ""));
  const challenge = (authorization.challenges as { type: string; url: string; token: string }[]).find(c => c.type === "http-01");
  if (!challenge || !/^[A-Za-z0-9_-]+$/.test(challenge.token)) throw new Error("HTTP-01 challenge missing");
  const challengeFile = path.join(root, "challenge", challenge.token);
  writeFileSync(challengeFile, `${challenge.token}.${thumbprint}`, { mode: 0o644 });
  try {
    json(await signed(challenge.url, {}));
    await waitFor(async () => {
      const value = json(await signed(authorizationUrl, ""));
      if (value.status === "invalid") throw new Error("Pebble HTTP-01 validation failed");
      return value.status === "valid";
    });
    const leaf = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const keyFile = path.join(root, "order.key");
    writeFileSync(keyFile, leaf.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const conf = path.join(root, "csr.conf");
    writeFileSync(conf, "[req]\nprompt=no\ndistinguished_name=dn\nreq_extensions=san\n[dn]\nCN=mixed.j15.test\n[san]\nsubjectAltName=DNS:mixed.j15.test\n", { mode: 0o600 });
    const csrFile = path.join(root, "order.csr");
    await command(["openssl", "req", "-new", "-key", keyFile, "-outform", "DER", "-out", csrFile, "-config", conf], env);
    json(await signed(String(order.finalize), { csr: readFileSync(csrFile).toString("base64url") }));
    let certificateUrl = "";
    await waitFor(async () => {
      const value = json(await signed(orderUrl, ""));
      certificateUrl = String(value.certificate ?? "");
      return value.status === "valid" && !!certificateUrl;
    });
    const issued = await signed(certificateUrl, "");
    if (issued.status !== 200) throw new Error("Certificate download failed");
    const certificate = new X509Certificate(issued.body);
    if (certificate.checkHost("mixed.j15.test") !== "mixed.j15.test"
      || !certificate.publicKey.export({ type: "spki", format: "der" }).equals(leaf.publicKey.export({ type: "spki", format: "der" }))) throw new Error("Issued certificate does not bind the requested host/key");
    const trustedRoot = await request("https://127.0.0.1:15000/roots/0");
    if (trustedRoot.status !== 200) throw new Error("Pebble trust root unavailable");
    const server = https.createServer({ key: leaf.privateKey.export({ type: "pkcs8", format: "pem" }), cert: issued.body }, (_req, res) => res.end("issued"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        const req = https.get({ hostname: "127.0.0.1", port: (server.address() as AddressInfo).port, servername: "mixed.j15.test", ca: trustedRoot.body, rejectUnauthorized: true, timeout: 5000 }, res => {
          res.resume(); res.on("end", () => res.statusCode === 200 ? resolve() : reject(new Error("Issued TLS endpoint refused")));
        });
        req.on("error", reject); req.on("timeout", () => req.destroy(new Error("Issued TLS timeout")));
      });
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } finally { unlinkSync(challengeFile); }
}

