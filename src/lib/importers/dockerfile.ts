/**
 * A single Dockerfile → one web service.
 *
 * A Dockerfile describes how to build one image, so the honest result is one
 * service. Anything about the build (RUN/COPY/WORKDIR) stays in the
 * Dockerfile — Orrery builds it, it does not re-model it.
 */
import { id } from "@/lib/domain/types";
import type { Manifest, Service } from "@/lib/domain/types";
import { emptyReport, SECRET_KEY_RE, slugify, type ImportReport } from "./types";

export interface DockerfileImport {
  manifest: Manifest;
  report: ImportReport;
}

const DEFAULT_PORT = 3000;

export function importDockerfile(text: string, name = "app"): DockerfileImport {
  const report = emptyReport();
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  if (!lines.some((l) => /^from\s/i.test(l))) {
    throw new Error("That does not look like a Dockerfile — no FROM instruction found. Paste a Dockerfile, or import a docker-compose.yml instead.");
  }

  const serviceName = slugify(name, "app");
  const exposed = lines
    .filter((l) => /^expose\s/i.test(l))
    .flatMap((l) => l.split(/\s+/).slice(1))
    .map((p) => Number(p.split("/")[0]))
    .filter((n) => Number.isInteger(n) && n > 0);

  const port = exposed[0] ?? DEFAULT_PORT;

  const service: Service = {
    id: id(),
    name: serviceName,
    kind: "web",
    source: { type: "git", repo: ".", ref: "main", dockerfile: "Dockerfile" },
    size: "small",
    replicas: 1,
    port,
    env: [],
    ownership: "managed",
  };

  for (const line of lines) {
    const m = /^env\s+(.+)$/i.exec(line);
    if (!m) continue;
    for (const { key, value } of parseEnv(m[1])) {
      if (SECRET_KEY_RE.test(key)) {
        service.env.push({ key, secretRef: `vault:${key}` });
        report.warnings.push(`${key} looks like a secret, so only a reference was imported. Set its value with system.setSecret.`);
      } else {
        service.env.push({ key, value });
      }
    }
  }

  report.mapped.push({
    source: "Dockerfile",
    result: `service ${serviceName} (web) on port ${port}`,
    confidence: exposed.length ? "exact" : "assumed",
    note: exposed.length
      ? `EXPOSE ${exposed[0]} set the port.`
      : `No EXPOSE instruction, so port ${DEFAULT_PORT} was assumed. Change it if your app listens elsewhere — a wrong port fails the health check at deploy time.`,
  });
  if (exposed.length > 1) {
    report.unmapped.push({
      source: "Dockerfile EXPOSE (extra ports)",
      reason: `An Orrery service listens on one port; ${exposed.length} were exposed.`,
      suggestion: `Kept ${port}. If another port matters, add a second service.`,
    });
  }
  report.mapped.push({
    source: "Dockerfile build instructions",
    result: "kept in your Dockerfile",
    confidence: "exact",
    note: "FROM/RUN/COPY/WORKDIR/CMD are build-time and stay where they are — Orrery builds the image from this file.",
  });
  report.unmapped.push({
    source: "Dockerfile",
    reason: "A Dockerfile describes one image, so no databases, caches or routes could be inferred.",
    suggestion: "Add the resources your app needs (system.addResource) and a route to publish it, or import a docker-compose.yml which carries them.",
  });
  report.warnings.push(`Source is set to the local path "." — set your git repository on ${serviceName} before deploying.`);

  return {
    manifest: { version: 1, services: [service], resources: [], routes: [], bindings: [] },
    report,
  };
}

function parseEnv(rest: string): { key: string; value: string }[] {
  // `ENV K=V K2=V2` or the legacy `ENV K V`
  if (rest.includes("=")) {
    return [...rest.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g)].map((m) => ({
      key: m[1],
      value: m[2].replace(/^["']|["']$/g, ""),
    }));
  }
  const [key, ...v] = rest.split(/\s+/);
  return key ? [{ key, value: v.join(" ") }] : [];
}
