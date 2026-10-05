/**
 * Exhaustive platform REST method/path classification. This module is Edge-safe:
 * it admits a bearer header to authentication, never authenticates one itself.
 * Unknown methods and paths keep the browser cookie gate.
 */
export type PlatformAccess = "bearer-capable" | "browser-only" | "agent-signed" | "webhook-signed" | "admin";

// Match the broker's id alphabet. No slashes, encoding, or dot segments.
const ID = "[A-Za-z0-9_-]{1,100}";
const AGENT_ID = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9_.:-]{1,128}`;
const ROOT = "/api/platform/v1";

export const PLATFORM_PATHS: readonly {
  path: RegExp;
  methods: Readonly<Partial<Record<string, PlatformAccess>>>;
}[] = [
  { path: new RegExp(`^${ROOT}/capabilities/(?:propose|check)$`), methods: { POST: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/operations$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/operations/${ID}$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/operations/${ID}/events$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/operations/${ID}/cancel$`), methods: { POST: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/operations/${ID}/(?:approve|reject)$`), methods: { POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/environments/${ID}/autonomy$`), methods: { GET: "bearer-capable", PUT: "browser-only" } },
  // reads authorised by the broker (authorizeRead); placement is a POST only to carry constraints
  { path: new RegExp(`^${ROOT}/environments/${ID}/(?:resources|drift|incidents)$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/environments/${ID}/placement$`), methods: { POST: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/environments/${ID}/teardown-review$`), methods: { GET: "bearer-capable", POST: "bearer-capable" } },
  // Signed runbooks: publish and approve need the person's browser; agents may request, schedule, cancel and read.
  { path: new RegExp(`^${ROOT}/runbooks$`), methods: { GET: "bearer-capable", POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/runbooks/${ID}/(?:runs|schedules)$`), methods: { POST: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/runbooks/(?:runs|schedules)$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/runbooks/runs/${ID}$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/runbooks/runs/${ID}/cancel$`), methods: { POST: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/runbooks/(?:runs|schedules)/${ID}/approve$`), methods: { POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/runbooks/schedules/${ID}/state$`), methods: { POST: "bearer-capable" } },
  // Release runs: reads are open to viewers; approving a data or contract migration needs the person's browser.
  { path: new RegExp(`^${ROOT}/releases$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/releases/${ID}$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/releases/${ID}/approve-migration$`), methods: { POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/capability-catalog$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/workspace/policy$`), methods: { GET: "bearer-capable", PUT: "browser-only" } },
  // Installation and repository binding require the human admin's browser session.
  { path: new RegExp(`^${ROOT}/github/callback$`), methods: { GET: "browser-only", POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/github/webhook$`), methods: { POST: "webhook-signed" } },
  { path: new RegExp(`^${ROOT}/(?:runners|machines)$`), methods: { GET: "admin" } },
  { path: new RegExp(`^${ROOT}/runners/tokens$`), methods: { POST: "admin" } },
  { path: new RegExp(`^${ROOT}/(?:runners|machines)/${AGENT_ID}/revoke$`), methods: { POST: "admin" } },
  { path: new RegExp(`^${ROOT}/(?:runners|machines)/register$`), methods: { POST: "agent-signed" } },
  { path: new RegExp(`^${ROOT}/(?:runners|machines)/${AGENT_ID}/(?:poll|heartbeat)$`), methods: { POST: "agent-signed" } },
  { path: new RegExp(`^${ROOT}/(?:runners|machines)/${AGENT_ID}/jobs/${AGENT_ID}/(?:result|logs)$`), methods: { POST: "agent-signed" } },
];

export function platformAccess(pathname: string, method: string): PlatformAccess | undefined {
  return PLATFORM_PATHS.find((entry) => entry.path.test(pathname))?.methods[method];
}

/** Scheme and a nonempty token only. The authority verifies syntax and validity. */
export function isPlatformBearerRequest(pathname: string, method: string, authorization: string | null): boolean {
  return platformAccess(pathname, method) === "bearer-capable" &&
    authorization !== null && /^Bearer [^\s]+$/i.test(authorization);
}
