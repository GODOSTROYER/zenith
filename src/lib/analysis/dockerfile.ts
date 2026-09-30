/**
 * Dockerfile and Procfile readers.
 *
 * The Dockerfile importer (`@/lib/importers`) is reused for the two things it
 * already answers well — the EXPOSEd port and the ENV pairs (with secret-named
 * keys already reduced to references, so a value is never seen). Everything the
 * importer does not surface — base images, CMD/ENTRYPOINT, HEALTHCHECK, line
 * numbers for evidence — is read here. Instructions are only READ: nothing in
 * a Dockerfile is run, and `RUN` lines are not interpreted at all.
 */
import { importDockerfile } from "@/lib/importers";
import { addEnv, addRuntime, ev } from "./record";
import type { Ctx, DockerfileFacts, ProcfileEntry, RootFacts } from "./model";
import { lines, MAX_PARSE_BYTES, portFromCommand, sanitizeInline } from "./text";
import type { Language } from "./types";

/* -------------------------------- instructions ---------------------------- */

interface Instruction {
  keyword: string;
  rest: string;
  line: number;
}

/** Join `\` continuations; drop comments and blanks. */
function instructions(content: string): Instruction[] {
  const out: Instruction[] = [];
  let pending: { text: string; line: number } | undefined;
  for (const { n, text } of lines(content)) {
    const t = text.trim();
    if (t.startsWith("#") || (t === "" && !pending)) continue;
    const cont = t.endsWith("\\") && !t.endsWith("\\\\");
    const piece = cont ? t.slice(0, -1).trimEnd() : t;
    if (pending) {
      pending.text += ` ${piece}`;
      if (!cont) {
        out.push(toInstruction(pending.text, pending.line));
        pending = undefined;
      }
    } else if (cont) pending = { text: piece, line: n };
    else out.push(toInstruction(piece, n));
  }
  if (pending) out.push(toInstruction(pending.text, pending.line));
  return out.filter((i) => i.keyword !== "");
}

function toInstruction(text: string, line: number): Instruction {
  const m = /^([A-Za-z]{2,12})(?:\s{1,10}(.{0,1500}))?$/.exec(text);
  return m ? { keyword: m[1].toUpperCase(), rest: (m[2] ?? "").trim(), line } : { keyword: "", rest: "", line };
}

/** `["node","server.js"]` → `node server.js`; shell form is returned as written. */
function commandText(rest: string): string {
  if (rest.startsWith("[")) {
    if (rest.length <= MAX_PARSE_BYTES) {
      try {
        const parsed: unknown = JSON.parse(rest);
        if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string") && parsed.length <= 60) return sanitizeInline(parsed.join(" "), 300);
      } catch {
        /* fall through to the raw text */
      }
    }
  }
  return sanitizeInline(rest, 300);
}

const URL_PATH = /https?:\/\/[^/\s"']{1,100}(\/[^\s"'|&;)]{0,100})?/;
const LOCAL_PATH = /(?:localhost|127\.0\.0\.1)(?::\d{2,5})?(\/[^\s"'|&;)]{0,100})/;

/** Language a base image implies, with the version from its tag. */
const IMAGE_LANG: [RegExp, Language][] = [
  [/^(?:library\/)?node$|\/node$/, "node"],
  [/^(?:library\/)?python$|\/python$/, "python"],
  [/^(?:library\/)?golang$|\/golang$|^(?:library\/)?go$/, "go"],
  [/^(?:library\/)?ruby$|\/ruby$/, "ruby"],
  [/^(?:library\/)?(?:openjdk|eclipse-temurin|amazoncorretto|maven|gradle)$|\/(?:openjdk|temurin|corretto|maven|gradle)$/, "java"],
  [/^(?:library\/)?rust$|\/rust$/, "rust"],
  [/^(?:library\/)?php$|\/php$/, "php"],
];

export function readDockerfile(ctx: Ctx, f: RootFacts, path: string): void {
  const content = ctx.idx.get(path) ?? "";
  const ins = instructions(content);
  const facts: DockerfileFacts = {
    path,
    from: [],
    expose: [],
    hasHealthcheck: false,
    envDefaults: new Map(),
    envSecretNames: new Set(),
    unpinnedBase: false,
  };
  const stages = new Set<string>();
  for (const i of ins) {
    switch (i.keyword) {
      case "FROM": {
        const tokens = i.rest.split(/\s{1,10}/).filter((t) => t !== "" && !t.startsWith("--"));
        const ref = tokens[0];
        if (!ref) break;
        const asName = tokens[1]?.toUpperCase() === "AS" ? tokens[2] : undefined;
        const digest = ref.includes("@");
        const noDigest = ref.split("@")[0];
        const colon = noDigest.lastIndexOf(":");
        const slash = noDigest.lastIndexOf("/");
        const image = colon > slash ? noDigest.slice(0, colon) : noDigest;
        const tag = colon > slash ? noDigest.slice(colon + 1) : undefined;
        facts.from.push({ image: sanitizeInline(image, 120), ...(tag ? { tag: sanitizeInline(tag, 60) } : {}), line: i.line });
        facts.unpinnedBase = !digest && image !== "scratch" && !stages.has(image) && (tag === undefined || tag === "latest");
        if (asName) stages.add(asName);
        break;
      }
      case "EXPOSE":
        for (const tok of i.rest.split(/\s{1,10}/)) {
          const p = /^(\d{1,5})(?:\/(?:tcp|udp))?$/.exec(tok);
          if (p && Number(p[1]) >= 1 && Number(p[1]) <= 65535) facts.expose.push({ port: Number(p[1]), line: i.line });
        }
        break;
      case "CMD":
        facts.cmd = { text: commandText(i.rest), line: i.line };
        break;
      case "ENTRYPOINT":
        facts.entrypoint = { text: commandText(i.rest), line: i.line };
        break;
      case "HEALTHCHECK": {
        if (/^NONE\b/i.test(i.rest)) break;
        facts.hasHealthcheck = true;
        const u = URL_PATH.exec(i.rest);
        const l = LOCAL_PATH.exec(i.rest);
        const p = u ? (u[1] ?? "/") : l?.[1];
        if (p) facts.healthPath = { path: p, line: i.line };
        break;
      }
    }
  }
  f.dockerfile = facts;
  const launch = portFromCommand(`${facts.entrypoint?.text ?? ""} ${facts.cmd?.text ?? ""}`);
  if (launch !== undefined) f.ports.push({ port: launch, rank: 6, source: "Dockerfile command flag", evidence: ev(path, "dockerfile:CMD", (facts.cmd ?? facts.entrypoint)?.line) });

  // Runtimes from base images: the first stage that names a known language wins per language.
  for (const from of facts.from) {
    const name = from.image.toLowerCase();
    const hit = IMAGE_LANG.find(([re]) => re.test(name));
    if (!hit) continue;
    const version = from.tag ? /^v?(\d{1,3}(?:\.\d{1,3}){0,2})/.exec(from.tag)?.[1] : undefined;
    addRuntime(ctx, f.root.dir, hit[1], version, version ? "high" : "medium", ev(path, "dockerfile:FROM", from.line));
  }

  // The importer answers port + env. It throws when there is no FROM.
  try {
    // the importer reads line by line; hand it the instructions with backslash continuations already joined
    const imported = importDockerfile(ins.map((i) => `${i.keyword} ${i.rest}`).join("\n"), "app");
    const service = imported.manifest.services[0];
    const exactPort = imported.report.mapped.some((m) => m.source === "Dockerfile" && m.confidence === "exact");
    if (service && exactPort && service.port !== undefined) {
      const line = facts.expose[0]?.line;
      f.ports.push({ port: service.port, rank: 5, source: "Dockerfile EXPOSE", evidence: ev(path, "dockerfile:EXPOSE", line) });
    }
    for (const e of service?.env ?? []) {
      const line = ins.find((i) => i.keyword === "ENV" && i.rest.includes(e.key))?.line;
      if (e.secretRef !== undefined) facts.envSecretNames.add(e.key);
      else if (e.value !== undefined) facts.envDefaults.set(e.key, e.value);
      addEnv(ctx, e.key, f.root.dir, "high", ev(path, "dockerfile:ENV", line), e.secretRef === undefined ? e.value : undefined);
      if (e.key === "PORT" && e.value !== undefined && /^\d{2,5}$/.test(e.value) && Number(e.value) <= 65535) f.ports.push({ port: Number(e.value), rank: 5, source: "Dockerfile ENV PORT", evidence: ev(path, "dockerfile:ENV", line) });
    }
  } catch {
    ctx.unknowns.add(`${path} has no FROM instruction, so it was not read as a Dockerfile.`);
  }
  if (facts.expose.length > 1) ctx.risks.add(`${path} exposes ${facts.expose.length} ports; a Zenith service listens on one, so the first (${facts.expose[0].port}) is used.`);
  if (facts.unpinnedBase) ctx.risks.add(`${path}: the final base image is not pinned (no tag or "latest"), so builds are not reproducible.`);
  ctx.infrastructure.add(`dockerfile\u0000${path}`, { kind: "dockerfile", path }, "high", ev(path, "file:Dockerfile"));
  if (f.dockerfile.healthPath) f.healths.push({ path: f.dockerfile.healthPath.path, declared: true, evidence: ev(path, "dockerfile:HEALTHCHECK", f.dockerfile.healthPath.line) });
}

/* --------------------------------- Procfile -------------------------------- */

export function readProcfile(ctx: Ctx, f: RootFacts, path: string): void {
  const entries: ProcfileEntry[] = [];
  for (const { n, text } of lines(ctx.idx.get(path) ?? "")) {
    const m = /^([A-Za-z0-9_-]{1,40}):\s{1,10}(\S.{0,500})$/.exec(text.trim());
    if (m) entries.push({ type: m[1].toLowerCase(), command: sanitizeInline(m[2], 300), line: n });
  }
  if (entries.length === 0) return;
  f.procfile = { path, entries };
  ctx.infrastructure.add(`procfile\u0000${path}`, { kind: "procfile", path, detail: `${entries.length} process type${entries.length === 1 ? "" : "s"}` }, "high", ev(path, "file:Procfile"));
  for (const e of entries) {
    const port = e.type === "web" || e.type.startsWith("web") ? portFromCommand(e.command) : undefined;
    if (port !== undefined) f.ports.push({ port, rank: 6, source: "Procfile flag", evidence: ev(path, "procfile:port-flag", e.line) });
  }
}

export const isDockerfileName = (base: string): boolean => {
  const lower = base.toLowerCase();
  return lower === "dockerfile" || lower === "containerfile" || lower.startsWith("dockerfile.") || lower.endsWith(".dockerfile");
};

