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
  // Mixed runs (PROD-MIX-03/04): reads and cancellation accept a person or a human-bound credential; teardown (propose, release,
  // sync) and output preauthorizations are a person's decisions and stay in the browser.
  { path: new RegExp(`^${ROOT}/operations/${ID}/mixed-run$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/operations/${ID}/mixed-run/cancel$`), methods: { POST: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/operations/${ID}/mixed-run/teardown$`), methods: { POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/mixed-output-preauthorizations$`), methods: { GET: "browser-only", POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/mixed-output-preauthorizations/${ID}/revoke$`), methods: { POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/environments/${ID}/autonomy$`), methods: { GET: "bearer-capable", PUT: "browser-only" } },
  // reads authorised by the broker (authorizeRead); placement is a POST only to carry constraints
  { path: new RegExp(`^${ROOT}/environments/${ID}/(?:resources|drift|incidents)$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/environments/${ID}/placement$`), methods: { POST: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/environments/${ID}/teardown-review$`), methods: { GET: "bearer-capable", POST: "bearer-capable" } },
  // Portability: stored verified exports, restores and adoptions are readable; starting an approved export, import, adopt or release needs the approver's own browser.
  { path: new RegExp(`^${ROOT}/environments/${ID}/portability$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/operations/${ID}/start-portability$`), methods: { POST: "browser-only" } },
  // State backend recovery (PROD-DUR-06): the capability matrix, a read-only probe and a proposal are open to a person or a human-bound credential;
  // approving, rejecting and running a restore need the approver's own browser.
  { path: new RegExp(`^${ROOT}/environments/${ID}/state-backend$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/environments/${ID}/state-backend/probe$`), methods: { POST: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/environments/${ID}/state-backend/restores$`), methods: { POST: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/environments/${ID}/state-backend/restores/(?:approve|reject|execute)$`), methods: { POST: "browser-only" } },
  // Signed runbooks: publish and approve need the person's browser; agents may request, schedule, cancel and read.
  { path: new RegExp(`^${ROOT}/runbooks$`), methods: { GET: "bearer-capable", POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/runbooks/${ID}/(?:runs|schedules)$`), methods: { POST: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/runbooks/(?:runs|schedules)$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/runbooks/runs/${ID}$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/runbooks/runs/${ID}/cancel$`), methods: { POST: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/runbooks/(?:runs|schedules)/${ID}/approve$`), methods: { POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/runbooks/schedules/${ID}/state$`), methods: { POST: "bearer-capable" } },
  // Connection lifecycle: reads and the observe-only verify/terminal revoke accept a person or a human-bound
  // linked credential; creating and rotating trust (which change what Zenith can reach) need the browser.
  { path: new RegExp(`^${ROOT}/connections$`), methods: { GET: "bearer-capable", POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/connections/${ID}$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/connections/${ID}/(?:verify|revoke)$`), methods: { POST: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/connections/${ID}/rotate$`), methods: { POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/connections/${ID}/rotation/(?:promote|abort)$`), methods: { POST: "browser-only" } },
  // Release runs: reads are open to viewers; approving a data or contract migration needs the person's browser.
  { path: new RegExp(`^${ROOT}/releases$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/releases/${ID}$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/releases/${ID}/approve-migration$`), methods: { POST: "browser-only" } },
  // Standing grants are a person's bounded pre-approval: creating, revoking and even listing stay in the person's browser.
  { path: new RegExp(`^${ROOT}/standing-grants$`), methods: { GET: "browser-only", POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/standing-grants/${ID}/revoke$`), methods: { POST: "browser-only" } },
  // External effects (provider calls whose outcome may be unknown): reads and the read-only readback accept a person or a
  // human-bound credential; resolving an uncertain effect needs the approver's own browser.
  { path: new RegExp(`^${ROOT}/effects$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/effects/${ID}$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/effects/${ID}/readback$`), methods: { POST: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/effects/${ID}/resolve$`), methods: { POST: "browser-only" } },
  // Coding-agent runs spend the workspace's model budget and stage a proposal: a workspace admin's own browser only.
  { path: new RegExp(`^${ROOT}/coding-agent/runs$`), methods: { GET: "browser-only", POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/coding-agent/runs/${ID}$`), methods: { GET: "browser-only" } },
  { path: new RegExp(`^${ROOT}/coding-agent/runs/${ID}/(?:resume|cancel|adopt)$`), methods: { POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/capability-catalog$`), methods: { GET: "bearer-capable" } },
  { path: new RegExp(`^${ROOT}/workspace/policy$`), methods: { GET: "bearer-capable", PUT: "browser-only" } },
  // Installation and repository binding require the human admin's browser session.
  { path: new RegExp(`^${ROOT}/github/callback$`), methods: { GET: "browser-only", POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/github/binding$`), methods: { GET: "browser-only", POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/github/binding/unbind$`), methods: { POST: "browser-only" } },
  { path: new RegExp(`^${ROOT}/github/inspect$`), methods: { GET: "browser-only" } },
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
