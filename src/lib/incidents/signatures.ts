/**
 * The error-signature table (spec §21, ADR-0014).
 *
 * Application logs and provider events are untrusted text. The investigation
 * NEVER interprets them: each line is matched against this fixed table and
 * nothing else. A line that matches no signature has no effect at all; a line
 * that matches contributes only (a) the signature id, (b) a count and time, and
 * (c) a redacted excerpt of at most 300 characters. Prose inside a log line
 * ("ignore previous instructions", "run kubectl …") is neither parsed nor
 * acted on, whatever it says.
 *
 * Every pattern is linear-time: literal alternations and BOUNDED repeats only
 * (`[^\n]{0,60}`, never `.*` or nested quantifiers), and each line is capped
 * at `MAX_INPUT_CHARS` before it is tested, so a hostile 1 MB line costs the
 * same as a 4 KB one.
 *
 * Honest limit: signatures are heuristics over the messages common runtimes
 * and clouds print (node-postgres, psycopg2, JDBC, ECS, Kubernetes, AWS SDK).
 * A framework that words its errors differently is a false negative, reported
 * as "no known signature", never as a pass for the underlying dependency.
 */
import { MAX_INPUT_CHARS, excerptAround, stripControl } from "./sanitize";

export type SignatureId =
  | "connect_timeout"
  | "connect_refused"
  | "dns_failure"
  | "auth_failure"
  | "db_unavailable"
  | "oom"
  | "http_5xx"
  | "missing_env"
  | "secret_error"
  | "iam_denied"
  | "image_pull"
  | "tls_error";

export interface Signature {
  id: SignatureId;
  description: string;
  /** alternatives, tried in order; each has its own flags (upper-case env names are matched case-sensitively) */
  res: readonly RegExp[];
  /** how many matching lines make it a finding (a 5xx burst is not one 502) */
  minCount: number;
}

export const SIGNATURES: readonly Signature[] = [
  {
    id: "connect_timeout",
    description: "connection timeouts",
    res: [/\bETIMEDOUT\b|connect(?:ion)? timed out|timeout expired|\bi\/o timeout\b|connect(?:ion)? timeout|SocketTimeoutException|ConnectTimeoutError|connection attempt (?:failed|timed out)/i],
    minCount: 1,
  },
  {
    id: "connect_refused",
    description: "connection refusals",
    res: [/\bECONNREFUSED\b|connection refused|refused the connection|actively refused|Connection to \S{1,120} refused/i],
    minCount: 1,
  },
  {
    id: "dns_failure",
    description: "host name resolution failures",
    res: [/\bENOTFOUND\b|\bEAI_AGAIN\b|\bEAI_NONAME\b|getaddrinfo|name or service not known|no such host|could not resolve host|\bNXDOMAIN\b|temporary failure in name resolution|UnknownHostException/i],
    minCount: 1,
  },
  {
    id: "auth_failure",
    description: "rejected credentials",
    res: [/password authentication failed|authentication failed for user|access denied for user|invalid (?:user(?:name)?|password)|no pg_hba\.conf entry|\bWRONGPASS\b|\bNOAUTH\b|SASL authentication failed/i],
    minCount: 1,
  },
  {
    id: "db_unavailable",
    description: "a database not accepting connections",
    res: [/the database system is (?:starting up|shutting down|in recovery mode)|terminating connection due to administrator command|too many connections|remaining connection slots are reserved|server closed the connection unexpectedly|SQLSTATE 57P0[1-3]|not accepting connections|Lost connection to MySQL server/i],
    minCount: 1,
  },
  {
    id: "oom",
    description: "out-of-memory errors",
    res: [/out of memory|OutOfMemoryError|\bOOM[- ]?kill(?:ed|er)?\b|cannot allocate memory|heap out of memory|exit code 137|\bsignal: killed\b|Killed process \d{1,10}/i],
    minCount: 1,
  },
  {
    id: "http_5xx",
    description: "HTTP 5xx server errors",
    res: [/(?:status(?:code)?["']?\s{0,3}[:=]\s{0,3}|HTTP\/[0-9.]{1,4}"?\s{1,3}|"\s{1,3}|\breturned\s{1,3})5\d\d\b|\b5\d\d (?:Service Unavailable|Bad Gateway|Gateway Time-?out|Internal Server Error)\b/i],
    minCount: 5,
  },
  {
    id: "missing_env",
    description: "missing environment variables",
    res: [
      /(?:missing|undefined|not set|required|unset)[^\n]{0,40}(?:environment variable|env(?:ironment)? var(?:iable)?)/i,
      /(?:environment variable|env var)[^\n]{0,40}(?:not set|missing|undefined|required|not defined)/i,
      /KeyError: ['"][A-Z][A-Z0-9_]{1,63}['"]/,
      /process\.env\.[A-Z][A-Z0-9_]{1,63} is undefined/,
      /\b[A-Z][A-Z0-9_]{2,63} (?:is )?not set\b/,
    ],
    minCount: 1,
  },
  {
    id: "secret_error",
    description: "secret fetch errors",
    res: [/ResourceInitializationError[^\n]{0,120}(?:secret|secretsmanager|ssm)|unable to pull secrets|Secrets ?Manager can'?t find|ResourceNotFoundException[^\n]{0,120}secret|secret[^\n]{0,80}(?:not found|does not exist|scheduled for deletion)|(?:failed|unable|could not|cannot) (?:to )?(?:fetch|resolve|retrieve|read|get) (?:the )?secret|ParameterNotFound/i],
    minCount: 1,
  },
  {
    id: "iam_denied",
    description: "access-denied errors",
    res: [/AccessDenied(?:Exception)?\b|is not authorized to perform:?\s{0,3}[A-Za-z0-9:*_.-]{1,80}|UnauthorizedOperation|\bAuthorizationError\b|\bPermissionDenied\b|caller does not have permission|not authorized to access|\bForbiddenException\b|explicit deny in (?:an? )?(?:identity|resource)-based policy/i],
    minCount: 1,
  },
  {
    id: "image_pull",
    description: "image pull errors",
    res: [/CannotPullContainerError|\bImagePullBackOff\b|\bErrImagePull\b|pull access denied|manifest (?:for \S{1,200} )?not found|manifest unknown|repository does not exist|failed to pull (?:and unpack )?image|toomanyrequests|no basic auth credentials/i],
    minCount: 1,
  },
  {
    id: "tls_error",
    description: "TLS or certificate errors",
    res: [/CERT_HAS_EXPIRED|certificate has expired|unable to verify the first certificate|self[- ]signed certificate|ERR_TLS_CERT_ALTNAME_INVALID|SSL(?:_| )routines|x509: certificate|certificate verify failed|SSLHandshakeException|ERR_CERT_/i],
    minCount: 1,
  },
];

export const SIGNATURE_BY_ID: Readonly<Record<SignatureId, Signature>> = Object.fromEntries(
  SIGNATURES.map((s) => [s.id, s])
) as Record<SignatureId, Signature>;

/* -------------------------------- extraction -------------------------------- */

const HOST_PORT = /(?:\d{1,3}(?:\.\d{1,3}){3}|(?=[A-Za-z0-9.-]{0,120}[A-Za-z])[A-Za-z0-9][A-Za-z0-9.-]{0,120}[A-Za-z0-9]):(\d{2,5})\b/g;
const HOST_PORT_HOST = /^((?:\d{1,3}(?:\.\d{1,3}){3})|(?:[A-Za-z0-9][A-Za-z0-9.-]{0,120}[A-Za-z0-9]))$/;
const PORT_WORD = /\bport\s{1,3}(\d{2,5})\b/gi;
const ENV_NAME = [
  /environment variable ["'`]?([A-Z][A-Z0-9_]{1,63})/i,
  /KeyError: ['"]([A-Z][A-Z0-9_]{1,63})['"]/,
  /process\.env\.([A-Z][A-Z0-9_]{1,63})/,
  /\b([A-Z][A-Z0-9_]{2,63}) (?:is )?not set\b/,
];
const ACTION = /is not authorized to perform:?\s{0,3}([A-Za-z0-9:*_.-]{1,80})/i;

/** Host/port pairs near a connection error: `connect ETIMEDOUT 10.0.3.15:5432`, `port 5432 failed`. */
function endpointsNear(text: string, index: number, length: number): { ports: number[]; hosts: string[] } {
  const window = text.slice(Math.max(0, index - 100), index + length + 200);
  const ports = new Set<number>();
  const hosts = new Set<string>();
  for (const m of window.matchAll(HOST_PORT)) {
    const port = Number(m[1]);
    if (port < 1 || port > 65535) continue;
    ports.add(port);
    const host = m[0].slice(0, m[0].length - m[1].length - 1);
    if (HOST_PORT_HOST.test(host)) hosts.add(host);
  }
  for (const m of window.matchAll(PORT_WORD)) {
    const port = Number(m[1]);
    if (port >= 1 && port <= 65535) ports.add(port);
  }
  return { ports: [...ports].slice(0, 5), hosts: [...hosts].slice(0, 3) };
}

/* ---------------------------------- scanning -------------------------------- */

export interface TextItem {
  timestamp: string;
  message: string;
  /** `logs` or `events`: where the line came from, for the evidence's source note */
  source: string;
}

export interface SignatureHit {
  signature: SignatureId;
  /** network signatures are grouped per target port (the first port a line names), so each dependency is attributed exactly */
  port?: number;
  count: number;
  firstAt?: string;
  lastAt?: string;
  /** epoch ms of each matching line (bounded), for before/after-a-change correlation */
  times: number[];
  /** up to 3 distinct redacted excerpts, most recent last, each at most 300 characters */
  samples: string[];
  sources: string[];
  ports: number[];
  hosts: string[];
  envVars: string[];
  actions: string[];
}

const NETWORK: ReadonlySet<SignatureId> = new Set(["connect_timeout", "connect_refused", "db_unavailable", "dns_failure"]);
const MAX_SCANNED = 1000;
const MAX_TIMES = 500;

function firstMatch(sig: Signature, line: string): { m: RegExpExecArray; re: RegExp } | undefined {
  for (const re of sig.res) {
    const m = re.exec(line);
    if (m) return { m, re };
  }
  return undefined;
}

const timeOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Match every item against the signature table. Items are ordered by time
 * (ties by text) first, so the result does not depend on the order a backend
 * returned them. Returns one hit per signature that matched at least once.
 */
export function scanText(items: readonly TextItem[]): { hits: SignatureHit[]; scanned: number; truncated: boolean } {
  const ordered = [...items]
    .sort((a, b) => timeOf(a.timestamp) - timeOf(b.timestamp) || cmp(a.message.slice(0, 256), b.message.slice(0, 256)))
    .slice(-MAX_SCANNED);
  const byKey = new Map<string, SignatureHit>();
  const samples = new Map<string, string[]>();

  for (const item of ordered) {
    if (typeof item.message !== "string" || item.message.length === 0) continue;
    const line = stripControl(item.message.length > MAX_INPUT_CHARS ? item.message.slice(0, MAX_INPUT_CHARS) : item.message);
    for (const sig of SIGNATURES) {
      const found = firstMatch(sig, line);
      if (!found) continue;
      const { m, re } = found;
      const near = NETWORK.has(sig.id) ? endpointsNear(line, m.index, m[0].length) : { ports: [] as number[], hosts: [] as string[] };
      const port = near.ports[0];
      const key = port !== undefined ? `${sig.id}:${port}` : sig.id;
      let hit = byKey.get(key);
      if (!hit) {
        hit = { signature: sig.id, ...(port !== undefined ? { port } : {}), count: 0, times: [], samples: [], sources: [], ports: [], hosts: [], envVars: [], actions: [] };
        byKey.set(key, hit);
        samples.set(key, []);
      }
      hit.count += 1;
      hit.firstAt ??= item.timestamp;
      hit.lastAt = item.timestamp;
      if (hit.times.length < MAX_TIMES) hit.times.push(timeOf(item.timestamp));
      if (!hit.sources.includes(item.source)) hit.sources.push(item.source);

      const excerpt = excerptAround(line, re);
      const seen = samples.get(key)!;
      if (!seen.includes(excerpt)) seen.push(excerpt);

      for (const p of near.ports) if (!hit.ports.includes(p) && hit.ports.length < 5) hit.ports.push(p);
      for (const h of near.hosts) if (!hit.hosts.includes(h) && hit.hosts.length < 3) hit.hosts.push(h);
      if (sig.id === "missing_env") {
        for (const envRe of ENV_NAME) {
          const e = envRe.exec(line);
          if (e && !hit.envVars.includes(e[1]) && hit.envVars.length < 5) {
            hit.envVars.push(e[1]);
            break;
          }
        }
      }
      if (sig.id === "iam_denied") {
        const a = ACTION.exec(line);
        if (a && !hit.actions.includes(a[1]) && hit.actions.length < 5) hit.actions.push(a[1]);
      }
    }
  }
  for (const [key, hit] of byKey) hit.samples = samples.get(key)!.slice(-3);
  return {
    hits: [...byKey.values()].sort((a, b) => cmp(a.signature, b.signature) || (a.port ?? 0) - (b.port ?? 0)),
    scanned: ordered.length,
    truncated: items.length > MAX_SCANNED,
  };
}
