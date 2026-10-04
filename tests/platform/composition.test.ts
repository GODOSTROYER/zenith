/** Composition contracts; all federation responses and vault credentials are synthetic. */
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { ConnectionConfig, ProviderSession } from "@/lib/credentials/types";
import { tempDataDir } from "../_support/data-dir";
tempDataDir("zenith-compose-contract-", { fast: true });
const { openPlatformDb, repos, PLATFORM_SCHEMA_VERSION } = await import("@/lib/controlplane/db");
const { PG_URL } = await import("../controlplane/_support/harness");
const { listDrivers } = await import("@/lib/drivers/types");
const { registerAllDrivers } = await import("@/lib/platform/drivers");
const { derivePlanFingerprintKey, composeExecutionActivities } = await import("@/lib/platform/execution");
const { platformCredentialBroker } = await import("@/lib/platform/credentials");
const { ensurePlatformApp, resetPlatformAppForTests, platformRunnerReaperPass } = await import("@/lib/platform/app");
const { resetPlatformBrokerForTests } = await import("@/lib/capabilities/platform");
const { resetRunnerRuntime } = await import("@/lib/runners/runtime");
const { reconcileWired, wireReconcilePorts } = await import("@/lib/reconcile/ports");
const { generateSigningJwk, LocalJwkSigner } = await import("@/lib/credentials/signing");
const { validateExecutionConfiguration, openExecutionStore } = await import("../../workers/execution/startup");
const { putSecretAsync } = await import("@/lib/secrets");
const { CONNECTION: gcp } = await import("../providers/gcp/_fake-google");
const { connection: azure } = await import("../providers/azure/_helpers");
let db: Awaited<ReturnType<typeof openPlatformDb>>;
let owningDb: Awaited<ReturnType<typeof openPlatformDb>> | undefined;
let signer: ReturnType<typeof LocalJwkSigner.fromJwk>;
if(process.env.ZENITH_TEST_SOURCE_FIXTURE_REQUIRED==="1") {
  if(!PG_URL)throw new Error("Default source fixture acceptance requires owned PostgreSQL.");
  if(PLATFORM_SCHEMA_VERSION<13)throw new Error("Default source fixtures require the canonical registered schema13.");
}
beforeAll(async () => {
  signer = LocalJwkSigner.fromJwk("test", (await generateSigningJwk("RS256")).privateJwk, { alg: "RS256" });
  if(PG_URL)owningDb=await openPlatformDb({kind:"postgres",url:PG_URL,migrate:true,max:1});
},60_000);
afterAll(async()=>{await owningDb?.close();});
beforeEach(async () => { db = await openPlatformDb({ kind: "pglite" }); resetPlatformAppForTests(); });
afterEach(async () => { await db.close(); resetPlatformAppForTests(); resetPlatformBrokerForTests(); resetRunnerRuntime(); wireReconcilePorts(null); vi.unstubAllEnvs(); });
const grant = (over: Partial<CapabilityGrantClaims> = {}): CapabilityGrantClaims => ({ jti: "grant-contract", iss: "zenith-control", aud: "worker", sub: "operator", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900, cap: "infrastructure.observe", ws: "ws-contract", op: "read-contract", env: "env-contract", digest: "0".repeat(64), ...over });
async function connection(config: ConnectionConfig) {
  const row = await repos.connections.create(db, { workspaceId: "ws-contract", config, createdBy: "operator" });
  await repos.connections.recordVerification(db, { workspaceId: row.workspaceId, id: row.id, ok: true, detail: "Seeded contract fixture, not live verification." });
  return row.id;
}

describe("platform composition", () => {
  it("registers one driver per provider/nativeType and uses only Zenith's own managed driver set", () => {
    registerAllDrivers(); const once = listDrivers(); registerAllDrivers(); const twice = listDrivers();
    const keys = twice.map((d) => `${d.provider}|${d.nativeType}`);
    expect(new Set(keys).size).toBe(keys.length); expect(twice.length).toBe(once.length);
    expect(new Set(twice.map((d) => d.provider))).toEqual(new Set(["aws", "kubernetes", "zenith", "gcp", "azure", "oci"]));
    expect(twice.filter((d) => d.provider === "zenith").every((d) => d.id.startsWith("zenith."))).toBe(true);
    for (const driver of twice) for (const level of Object.values(driver.capabilities.evidence)) expect(level).toBe("contract");
  });
  it("derives stable domain-separated fingerprints and refuses missing/malformed secrets even with fake tofu", () => {
    expect(derivePlanFingerprintKey("1".repeat(64))).toBe(derivePlanFingerprintKey("1".repeat(64)));
    expect(derivePlanFingerprintKey("1".repeat(64))).not.toBe(derivePlanFingerprintKey("2".repeat(64)));
    expect(derivePlanFingerprintKey("1".repeat(64))).not.toBe("1".repeat(64));
    vi.stubEnv("ZENITH_SECRET_KEY", "");
    expect(() => composeExecutionActivities({ db, workerIdentity: "test", planDir: "unused" })).toThrow("ZENITH_SECRET_KEY");
    expect(() => derivePlanFingerprintKey("invalid")).toThrow("64 hex");
  });
  it("refuses production PGlite custody and admits only an explicit isolated adapter with an explicit engine",async()=> {
    const {createWorld}=await import("../execution/fakes/world");
    const world=createWorld();
    try {
      const activities=composeExecutionActivities({db,workerIdentity:"test",planDir:world.planDir,secretKey:"1".repeat(64),ports:{
        ops:world.ops,leases:world.leases,evidence:world.evidence,resources:world.resources,product:world.product,broker:world.broker,
        credentials:world.credentials,connections:world.connections,drivers:world.drivers,sourceBundle:world.sourceBundle,sourceSnapshots:world.deps.sourceSnapshots,machines:world.deps.machines,
      }});
      // Composition remains available to machine/source reads; the first infrastructure request fails closed.
      const lease=await world.lease();
      const op=world.ops.ops.values().next().value;
      if(!op)throw new Error("Composition fixture operation is unavailable.");
      await expect(activities.planInfrastructure({operationId:op.id,lease})).rejects.toThrow("PostgreSQL");
      expect(world.tofu.planCalls).toHaveLength(0);expect(world.tofu.applyCalls).toHaveLength(0);
      expect(world.evidence.ofKind("tofu_plan")).toHaveLength(0);expect(world.ops.uncertain).toHaveLength(0);
      expect(()=>composeExecutionActivities({db,workerIdentity:"test",planDir:world.planDir,secretKey:"1".repeat(64),ports:{planArtifacts:world.deps.planArtifacts}})).toThrow("explicit isolated engine");
      expect(()=>composeExecutionActivities({db,workerIdentity:"test",planDir:world.planDir,secretKey:"1".repeat(64),ports:{planArtifacts:world.deps.planArtifacts,tofu:world.tofu,sourceBundle:world.sourceBundle,sourceSnapshots:world.deps.sourceSnapshots,machines:world.deps.machines}})).not.toThrow();
      vi.stubEnv("NODE_ENV","production");
      expect(()=>composeExecutionActivities({db,workerIdentity:"test",planDir:world.planDir,secretKey:"1".repeat(64),ports:{planArtifacts:world.deps.planArtifacts,tofu:world.tofu}})).toThrow("only in the test environment");
    } finally {world.dispose();}
  });
  it.skipIf(!PG_URL).each(["absent","present"] as const)("captures optional tool authority %s at composition before lazy resolution",async label=> {
    const initiallyPresent=label==="present";
    const {createWorld}=await import("../execution/fakes/world");
    const binary=await import("@/lib/tofu/binary");
    const world=createWorld();
    const optional=["ZENITH_TOFU_BIN","ZENITH_TOFU_IDENTITY_FILE","ZENITH_TOFU_PLUGIN_CACHE"];
    for(const key of optional)vi.stubEnv(key,initiallyPresent ? `/captured/${key}` : undefined);
    vi.stubEnv("ZENITH_PLAN_ARTIFACT_KEY","2".repeat(64));
    vi.stubEnv("ZENITH_SECRET_KEY","1".repeat(64));
    vi.stubEnv("ZENITH_WORKER_PLAN_DIR",world.planDir);
    const expected=Object.freeze({...process.env});
    let observed:Readonly<Record<string,string|undefined>>|undefined;
    const resolve=vi.spyOn(binary,"resolveTofuBinary").mockImplementation(host=>{
      observed=host;
      throw new Error("Captured tool authority fixture stopped before executing OpenTofu.");
    });
    try {
      // The default lazy custody constructor receives a physical PostgreSQL
      // handle. The binary resolver stops before executing OpenTofu.
      if(!owningDb || owningDb.kind!=="postgres")throw new Error("Owned tool-capture PostgreSQL fixture is unavailable.");
      const activities=composeExecutionActivities({db:owningDb,workerIdentity:"capture-contract",planDir:world.planDir,secretKey:"1".repeat(64),ports:{
        ops:world.ops,leases:world.leases,evidence:world.evidence,resources:world.resources,product:world.product,broker:world.broker,
        credentials:world.credentials,connections:world.connections,drivers:world.drivers,sourceBundle:world.sourceBundle,sourceSnapshots:world.deps.sourceSnapshots,machines:world.deps.machines,
      }});
      for(const key of optional)vi.stubEnv(key,`/late/${key}`);
      vi.stubEnv("ZENITH_PLAN_ARTIFACT_KEY","3".repeat(64));
      vi.stubEnv("ZENITH_SECRET_KEY","4".repeat(64));
      vi.stubEnv("ZENITH_WORKER_PLAN_DIR","/late/plan-root");
      vi.stubEnv("PATH","/late/path");
      vi.stubEnv("NODE_ENV","production");
      const lease=await world.lease();
      const op=world.ops.ops.values().next().value;
      if(!op)throw new Error("Composition fixture operation is unavailable.");
      await expect(activities.planInfrastructure({operationId:op.id,lease})).rejects.toThrow("Captured tool authority fixture");
      expect(resolve).toHaveBeenCalledOnce();
      expect(Object.isFrozen(observed)).toBe(true);
      if(!observed)throw new Error("Captured runner environment is unavailable.");
      // Boolean comparisons avoid exposing environment values in assertion diagnostics.
      for(const key of [...optional,"PATH","NODE_ENV","ZENITH_WORKER_PLAN_DIR","ZENITH_PLAN_ARTIFACT_KEY","ZENITH_SECRET_KEY","ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS","ZENITH_VAULT_PREVIOUS_SECRET_KEYS"]) {
        expect(observed[key]===expected[key]).toBe(true);
        expect(Object.hasOwn(observed,key)).toBe(Object.hasOwn(expected,key));
      }
      expect(world.tofu.applyCalls).toHaveLength(0);
      expect(world.evidence.ofKind("tofu_plan")).toHaveLength(0);
      expect(world.ops.uncertain).toHaveLength(0);
    } finally {resolve.mockRestore();world.dispose();}
  });
  it("uses only an explicit partial engine environment and preserves omitted-environment defaults",async()=> {
    const binary=await import("@/lib/tofu/binary");
    const {createPlanEngineAuthority}=await import("@/lib/tofu/engine");
    const {planArtifactCipherFromEnv}=await import("@/lib/platform/plan-artifacts");
    const {builtinWorkspace,dataFragment}=await import("../tofu/_helpers");
    const ws=builtinWorkspace("/tmp/zenith-captured-tool-authority-state.tfstate",{"resource/test":dataFragment("test","fixture")});
    const cipher=planArtifactCipherFromEnv({ZENITH_PLAN_ARTIFACT_KEY:"2".repeat(64)});
    let observed:Readonly<Record<string,string|undefined>>|undefined;
    const resolve=vi.spyOn(binary,"resolveTofuBinary").mockImplementation(host=>{
      observed=host;throw new Error("Captured tool authority fixture stopped before executing OpenTofu.");
    });
    try {
      const explicit={PATH:"/explicit/path",NODE_ENV:"test"};
      const partial=createPlanEngineAuthority(cipher,()=>undefined,explicit);
      vi.stubEnv("ZENITH_TOFU_BIN","/late/bin");
      await expect(partial.tofu.planWorkspace(ws)).rejects.toThrow("Captured tool authority fixture");
      expect(Object.keys(observed??{}).sort()).toEqual(Object.keys(explicit).sort());
      expect(observed?.PATH).toBe(explicit.PATH);
      const captured=Object.freeze({...process.env});
      const defaults=createPlanEngineAuthority(cipher,()=>undefined);
      vi.stubEnv("ZENITH_TOFU_BIN","/later/bin");
      await expect(defaults.tofu.planWorkspace(ws)).rejects.toThrow("Captured tool authority fixture");
      expect(observed?.ZENITH_TOFU_BIN===captured.ZENITH_TOFU_BIN).toBe(true);
      expect(Object.isFrozen(observed)).toBe(true);
    } finally {resolve.mockRestore();}
  });
  it("leaves the legacy app and reconcile 503 behavior alone without platform configuration", async () => {
    vi.stubEnv("ZENITH_PLATFORM_DB", ""); vi.stubEnv("ZENITH_PLATFORM_DB_URL", "");
    expect(await ensurePlatformApp()).toBe(false);
    expect(reconcileWired()).toBe(false);
    expect(await platformRunnerReaperPass()).toEqual({ ran: false, jobs: 0 });
  });
  it("wires the configured schema exactly once without requiring a signer to reap queues", async () => {
    vi.stubEnv("ZENITH_CONTROL_SIGNING_JWK", "");
    const first = ensurePlatformApp(db); const second = ensurePlatformApp(db);
    expect(first).toBe(second); expect(await first).toBe(true); expect(reconcileWired()).toBe(true);
    expect(await platformRunnerReaperPass()).toEqual({ ran: true, jobs: 0 });
  });
  it("fails tolerantly when schema is behind instead of silently migrating production", async () => {
    await db.query("delete from platform.schema_migrations where version=(select max(version) from platform.schema_migrations)");
    expect(await ensurePlatformApp(db)).toBe(false); expect(reconcileWired()).toBe(false);
  });
  it("fails worker startup on missing secret/signing/store configuration without exposing error input", async () => {
    const base = { ZENITH_TEMPORAL_ADDRESS: "127.0.0.1:17233", ZENITH_SECRET_KEY: "1".repeat(64), ZENITH_PLATFORM_DB: "pglite" };
    await expect(validateExecutionConfiguration({ ...base, ZENITH_TEMPORAL_ADDRESS: "" })).rejects.toThrow("TEMPORAL_ADDRESS");
    await expect(validateExecutionConfiguration({ ...base, ZENITH_SECRET_KEY: "" })).rejects.toThrow("SECRET_KEY");
    await expect(validateExecutionConfiguration({ ...base, ZENITH_CONTROL_SIGNING_JWK: "PRIVATE-CONTRACT-CANARY" })).rejects.toThrow("usable ZENITH_CONTROL_SIGNING_JWK");
    await expect(openExecutionStore(async () => { throw new Error("DATABASE-CONTRACT-CANARY"); })).rejects.toThrow("Platform store could not open");
    // Startup owns each opened handle and closes it on refusal. Keep the
    // beforeEach handle available for its own afterEach cleanup.
    for (const oldSchema of [false,true]) {
      const startupDb=await openPlatformDb({kind:"pglite"});
      const close=vi.spyOn(startupDb,"close");
      try {
        if(oldSchema)await startupDb.query("delete from platform.schema_migrations where version=(select max(version) from platform.schema_migrations)");
        await expect(openExecutionStore(async()=>startupDb)).rejects.toThrow(oldSchema?"Platform schema is behind":"requires PostgreSQL");
        expect(close).toHaveBeenCalledOnce();
        await expect(startupDb.query("select 1")).rejects.toThrow("closed");
      } finally {
        if(close.mock.calls.length===0)await startupDb.close();
        close.mockRestore();
      }
    }
  });
});

describe("provider credential router", () => {
  it("mints a scoped subject, exchanges Google federation, audits and ends the session", async () => {
    const id = await connection(gcp);
    const subjects: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url === "https://sts.googleapis.com/v1/token") {
        const body = JSON.parse(String(init?.body)) as { subjectToken: string };
        subjects.push(decodeJwt(body.subjectToken));
        return Response.json({ access_token: "google-contract-sts", token_type: "Bearer", expires_in: 900 });
      }
      if (url.includes("iamcredentials.googleapis.com")) return Response.json({ accessToken: "google-contract-canary", expireTime: new Date(Date.now() + 900_000).toISOString() });
      return Response.json({ ok: true });
    });
    const credentials = platformCredentialBroker(db, { oidc: { signer, issuer: "https://zenith.test/api/oidc" }, fetchImpl });
    let held: ProviderSession | undefined;
    await credentials.withSession({ connectionId: id, grant: grant(), purpose: "observe" }, async (session) => {
      held = session; expect(session.provider).toBe("gcp");
      if (session.provider === "gcp") expect((await session.authorizedFetch("https://compute.googleapis.com/compute/v1/projects")).status).toBe(200);
      expect(JSON.stringify(session)).not.toContain("google-contract-canary");
    });
    expect(subjects[0]).toMatchObject({ sub: `zenith:ws:ws-contract:conn:${id}`, aud: `https://iam.googleapis.com/${gcp.workloadIdentityProvider}` });
    if (held?.provider === "gcp") await expect(held.authorizedFetch("https://compute.googleapis.com/compute/v1/projects")).rejects.toThrow();
    const events = await repos.events.list(db, "ws-contract", { limit: 50 });
    expect(events.map((e) => e.type)).toContain("credential.assumed");
    expect(events[0].operationId).toBeUndefined(); expect(JSON.stringify(events)).not.toContain("google-contract-canary");
  });
  it("mints Azure assertions for the exchange audience and revokes access after callback failure", async () => {
    const id = await connection(azure); const subjects: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      if (String(input).startsWith("https://login.microsoftonline.com/")) {
        const body = new URLSearchParams(String(init?.body)); subjects.push(decodeJwt(body.get("client_assertion")!));
        return Response.json({ access_token: "azure-contract-canary", token_type: "Bearer", expires_in: 900 });
      }
      return Response.json({ value: [] });
    });
    const credentials = platformCredentialBroker(db, { oidc: { signer, issuer: "https://zenith.test/api/oidc" }, fetchImpl });
    let held: ProviderSession | undefined;
    await expect(credentials.withSession({ connectionId: id, grant: grant(), purpose: "observe" }, async (session) => {
      held = session;
      if (session.provider === "azure") await session.authorizedFetch("https://management.azure.com/subscriptions?api-version=2022-12-01");
      throw new Error("callback failed");
    })).rejects.toThrow("callback failed");
    expect(subjects[0]).toMatchObject({ sub: `zenith:ws:ws-contract:conn:${id}`, aud: "api://AzureADTokenExchange" });
    if (held?.provider === "azure") await expect(held.authorizedFetch("https://management.azure.com/subscriptions")).rejects.toThrow();
  });
  it("resolves a Kubernetes vault reference only in memory and refuses reuse", async () => {
    vi.stubEnv("ZENITH_SECRET_KEY", "1".repeat(64));
    const ref = "vault:project/service/KUBE_TOKEN";
    await putSecretAsync("ws-contract", ref, "kubernetes-contract-canary", "operator");
    const id = await connection({ provider: "kubernetes", mode: "kubeconfig_ref", server: "https://cluster.example.test", namespaces: ["app"], credentialRef: ref });
    let held: ProviderSession | undefined;
    await platformCredentialBroker(db).withSession({ connectionId: id, grant: grant(), purpose: "observe" }, async (session) => {
      held = session; expect(session.provider).toBe("kubernetes");
      if (session.provider === "kubernetes") expect(session.kubeConfig()).toBeDefined();
      expect(JSON.stringify(session)).not.toContain("kubernetes-contract-canary");
    });
    if (held?.provider === "kubernetes") { const kubernetes = held; expect(() => kubernetes.kubeConfig()).toThrow("session has ended"); }
    expect(JSON.stringify(await repos.events.list(db, "ws-contract", { limit: 50 }))).not.toContain("kubernetes-contract-canary");
  });
  it("refuses foreign tenants, purpose mismatch, expired grants, and OCI without an active registered runner, before any exchange", async () => {
    const id = await connection(gcp); const fetchImpl = vi.fn<typeof fetch>();
    const credentials = platformCredentialBroker(db, { fetchImpl });
    await expect(credentials.withSession({ connectionId: id, grant: grant({ ws: "other" }), purpose: "observe" }, async () => undefined)).rejects.toThrow("not found");
    await expect(credentials.withSession({ connectionId: id, grant: grant(), purpose: "deploy" }, async () => undefined)).rejects.toThrow("purpose");
    await expect(credentials.withSession({ connectionId: id, grant: grant({ exp: 0 }), purpose: "observe" }, async () => undefined)).rejects.toThrow("expired");
    const oci = await connection({ provider: "oci", mode: "runner", tenancyOcid: "ocid1.tenancy.oc1..fixture", compartmentOcid: "ocid1.compartment.oc1..fixture", region: "us-ashburn-1", runnerId: "runner-contract" });
    await expect(credentials.withSession({ connectionId: oci, grant: grant(), purpose: "observe" }, async () => undefined)).rejects.toThrow("An active OCI runner is unavailable"); // OCI sessions exist only through a runner
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("never treats session creation as provider identity verification", async () => {
    const id = await connection(gcp);
    expect(await platformCredentialBroker(db).verifyConnection(id, { workspaceId: "ws-contract" })).toMatchObject({ ok: false });
  });
});
