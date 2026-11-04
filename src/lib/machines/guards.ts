/**
 * Pure input guards shared by argument validation, the transports and the SSM
 * document generator: network target checks, absolute-path normalization,
 * file-read allowlists, protected units and relative durations.
 *
 * Everything here is string-in / verdict-out with no I/O. External strings are
 * data: none of these functions ever builds a command from its input.
 *
 * Honest limit of the network guards: they judge the literal name or address
 * they are given. A name that RESOLVES to a link-local or metadata address is
 * only caught where something resolves it, so the agents (the SSM PortCheck
 * document, zenithd, the runner) repeat the check against resolved addresses.
 */
import { isIPv6 } from "node:net";
import { FILE_READ_DENY_GLOBS, MAX_PATH_CHARS, MAX_SINCE_SEC } from "./limits";

/* ------------------------------ network hosts ------------------------------ */

export type HostCheck =
  | { ok: true; host: string; kind: "ipv4" | "ipv6" | "name" }
  | { ok: false; reason: string };

/** Names that always mean "the cloud metadata service", compared lowercase without a trailing dot. */
const DENIED_NAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.tencentyun.com",
]);
const DENIED_NAME_SUFFIXES = [".metadata.google.internal", ".metadata.goog"];

/** Strict dotted-quad: four decimal octets, no leading zeros, nothing else. */
export function parseIPv4Strict(s: string): [number, number, number, number] | null {
  const m = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$/.exec(s);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  return o.every((n) => n <= 255) ? o : null;
}

/** Why an IPv4 address is refused, or null when it is fine. */
export function deniedIPv4Reason(o: readonly number[]): string | null {
  if (o[0] === 169 && o[1] === 254) return "link-local / instance-metadata address (169.254.0.0/16)";
  if (o[0] === 0) return "unspecified address (0.0.0.0/8)";
  if (o[0] === 100 && o[1] === 100 && o[2] === 100 && o[3] === 200) return "cloud metadata address (100.100.100.200)";
  if (o[0] === 168 && o[1] === 63 && o[2] === 129 && o[3] === 16) return "cloud platform address (168.63.129.16)";
  return null;
}

/** Eight 16-bit groups of an IPv6 literal, or null when it is not one (zone ids are refused). */
export function parseIPv6(s: string): number[] | null {
  if (s.includes("%") || !isIPv6(s)) return null;
  let head = s;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4Strict(tail);
    if (!v4) return null;
    head = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - left.length - right.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

export function deniedIPv6Reason(g: readonly number[]): string | null {
  if (g.every((x) => x === 0)) return "unspecified address (::)";
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local address (fe80::/10)";
  if (g[0] === 0xfd00 && g[1] === 0x0ec2) return "instance-metadata address (fd00:ec2::/32)";
  const embedded = (a: number, b: number) => deniedIPv4Reason([a >> 8, a & 0xff, b >> 8, b & 0xff]);
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the embedded IPv4
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0) && !(g[5] === 0 && g[6] === 0 && g[7] <= 1)) {
    const r = embedded(g[6], g[7]);
    if (r) return `embedded IPv4: ${r}`;
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const r = embedded(g[6], g[7]);
    if (r) return `embedded IPv4: ${r}`;
  }
  // 6to4 2002:AABB:CCDD::/48 embeds the IPv4 in groups 1 and 2
  if (g[0] === 0x2002) {
    const r = embedded(g[1], g[2]);
    if (r) return `embedded IPv4: ${r}`;
  }
  return null;
}

/**
 * Validate a host for `network.portCheck` / `network.dnsCheck`. Accepts a
 * canonical IPv4 literal, an IPv6 literal (no zone id), or an RFC 1123 name.
 * Refuses link-local and metadata addresses and names, non-canonical numeric
 * forms an HTTP/URL parser would silently turn into an address (`2852039166`,
 * `0xA9FEA9FE`, `0251.0376.0251.0376`) and anything with characters outside
 * the DNS/IP alphabet. Returns the canonical (lowercase, no trailing dot) host.
 */
export function checkNetworkHost(input: string, opts: { allowUnderscore?: boolean } = {}): HostCheck {
  if (input.length < 1 || input.length > 253) return { ok: false, reason: "host must be 1-253 characters" };
  if (input.includes(":")) {
    const g = parseIPv6(input);
    if (!g) return { ok: false, reason: "not a valid IPv6 literal (zone ids are not accepted)" };
    const denied = deniedIPv6Reason(g);
    return denied ? { ok: false, reason: `refused: ${denied}` } : { ok: true, host: input.toLowerCase(), kind: "ipv6" };
  }
  const trimmed = input.endsWith(".") ? input.slice(0, -1) : input;
  if (trimmed.length === 0) return { ok: false, reason: "empty host" };
  if (/^[0-9.]+$/.test(trimmed)) {
    const v4 = parseIPv4Strict(trimmed);
    if (!v4) return { ok: false, reason: "non-canonical numeric host; use a dotted-quad IPv4 address or a name" };
    const denied = deniedIPv4Reason(v4);
    return denied ? { ok: false, reason: `refused: ${denied}` } : { ok: true, host: trimmed, kind: "ipv4" };
  }
  const name = trimmed.toLowerCase();
  const label = opts.allowUnderscore ? /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/ : /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const labels = name.split(".");
  if (!labels.every((l) => label.test(l))) return { ok: false, reason: "host contains characters outside the DNS alphabet" };
  const last = labels[labels.length - 1];
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) {
    return { ok: false, reason: "host's final label looks like a numeric address" };
  }
  if (DENIED_NAMES.has(name) || DENIED_NAME_SUFFIXES.some((s) => name.endsWith(s))) {
    return { ok: false, reason: "refused: cloud metadata service name" };
  }
  return { ok: true, host: name, kind: "name" };
}

/* ---------------------------------- paths ---------------------------------- */

export type PathCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The only characters a path handed to a machine may contain. Deliberately
 * excludes space, glob and shell metacharacters (`;|&$`` `"'\\<>()*?[]{}!#~%`)
 * and every control character, so a validated path is inert in every
 * downstream context (SSM ENV_VAR parameter, argv, JSON, journal lines).
 */
const SAFE_PATH = /^[A-Za-z0-9._@:+=,/-]+$/;

/**
 * Normalize an absolute POSIX path: must start with `/`, may not contain `..`
 * anywhere (not even inside a name), NUL/newline/control characters, or
 * characters outside `SAFE_PATH`. Duplicate slashes and `.` segments are
 * collapsed; a trailing slash is dropped.
 */
export function normalizeAbsolutePath(input: string): PathCheck {
  if (input.length === 0 || input.length > MAX_PATH_CHARS) return { ok: false, reason: `path must be 1-${MAX_PATH_CHARS} characters` };
  if (!input.startsWith("/")) return { ok: false, reason: "path must be absolute" };
  if (!SAFE_PATH.test(input)) return { ok: false, reason: "path contains characters outside [A-Za-z0-9._@:+=,/-]" };
  if (input.includes("..")) return { ok: false, reason: "path may not contain '..'" };
  const segs = input.split("/").filter((s) => s !== "" && s !== ".");
  return { ok: true, path: `/${segs.join("/")}` };
}

/** `prefixes` follow `DEFAULT_FILE_READ_PREFIXES`: `/dir/` allows a subtree, `/file` exactly that file. */
export function pathAllowed(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

const globRegex = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
const DENY_REGEXES = FILE_READ_DENY_GLOBS.map(globRegex);

/** true when the (normalized, symlink-resolved) path matches a never-readable pattern */
export function isDeniedFilePath(path: string): boolean {
  return DENY_REGEXES.some((r) => r.test(path));
}

/** Writes use canonical exact paths, with no normalization after approval. */
export function isCanonicalWritePath(input: string): boolean {
  const normalized = normalizeAbsolutePath(input);
  return normalized.ok && normalized.path === input && input !== "/" && !/\s/.test(input);
}
export function isDeniedWritePath(input: string): boolean {
  const roots = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/proc", "/sys", "/dev", "/run", "/var/lib/zenithd", "/var/spool", "/var/log", "/root"];
  if (roots.some((p) => input === p || input.startsWith(`${p}/`))) return true;
  return input.toLowerCase().split("/").some((c) => c.startsWith(".") || ["systemd", "cron", "crontabs", "sudoers", "sudoers.d", "polkit-1", "bin", "sbin", "identity.json", "replay.jsonl", "audit.jsonl", "config.yaml", "config.json"].includes(c) || /\.(service|socket|timer|sh)$/.test(c));
}
export function writePathAllowed(input: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => input === p || input.startsWith(`${p}/`));
}

/* ---------------------------------- units ---------------------------------- */

/** `systemctl restart` of these would cut Zenith's own channel or the host's control plane. */
const PROTECTED_UNITS: readonly RegExp[] = [
  /^(ssh|sshd)(@.*)?\.(service|socket)$/,
  /^systemd-.*/,
  /^dbus(-broker)?\.(service|socket)$/,
  /^amazon-ssm-agent\.service$/,
  /^snap\.amazon-ssm-agent\..*/,
  /^zenithd\.service$/,
  /^zenith-runner\.service$/,
];
export const isProtectedUnit = (unit: string): boolean => PROTECTED_UNITS.some((r) => r.test(unit));

/* --------------------------------- durations -------------------------------- */

/** `15m` / `2h` / `1d` / `900s` → seconds, or null when malformed or beyond 7 days. */
export function parseSince(since: string): number | null {
  const m = /^([1-9][0-9]{0,5})([smhd])$/.exec(since);
  if (!m) return null;
  const n = Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
  return n <= MAX_SINCE_SEC ? n : null;
}
