import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

/** Runtime-only local test identity; no keys or certificates enter the repository. */
export function testTlsIdentity(hostname = "service.example.test") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-portability-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${hostname}`, "-addext", `subjectAltName=${net.isIP(hostname) ? "IP" : "DNS"}:${hostname}`, "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" });
    return { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
