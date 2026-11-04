/**
 * PROD-MAN-03 tenant object storage: the scoped policy (evaluated, not just compared), per-tenant intents, the provisioning
 * lifecycle (create, converge, rotate, revoke, crash safety) against an IAM-shaped fake, and the IAM adapter's contract with a
 * recording SDK. The provider is a double; see tests/managed-serving/_support/storage.ts for what that does and does not prove.
 */
import { describe, expect, it } from "vitest";
import {
  assertScopedPrefix, createIamAdminPort, policyDigest, principalNameFor, provisionObjectStores, refuseObjectStores, revokeObjectStoreKeys, scopedStoragePolicy, settleRevocations,
  storageIntentFromNode, storageKeyIdRef, storageSecretRef, storageWorkloadEnv, unavailableStorageAdmin, type IamClientLike, type IamSdk, type ManagedStorageIntent,
} from "@/lib/managed-serving/storage";
import { createBrokeredIamAdminPort } from "@/lib/managed-serving/storage";
import { CredentialDeniedError } from "@/lib/credentials/types";
import { assertVaultScope } from "@/lib/secrets/resolver";
import { FULL_ENV, TENANT, mkNode, substrate } from "../providers/zenith/support";
import { FakeAdmin, MemoryKeyStore, MemorySink, bucketArn, evaluate, objectArn } from "./_support/storage";

const ENV = { ...FULL_ENV, ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF: "vault:zenith-managed/object-store-admin" };
const sub = substrate(ENV);
const OS = mkNode("object_store/media", "object_store", { versioning: true, publicAccess: false });
const intentOf = (tenant = TENANT, node = OS): ManagedStorageIntent => storageIntentFromNode(tenant, sub, node);

describe("the scoped policy", () => {
  const intent = intentOf();
  const policy = scopedStoragePolicy(intent.bucket, intent.prefix);
  const key = (rest: string): string => `${intent.prefix}${rest}`;

  it("allows object access under the store's own prefix and nothing else", () => {
    for (const action of ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]) {
      expect(evaluate(policy, { action, resource: objectArn(intent.bucket, key("a/b.txt")) }), action).toBe(true);
    }
    expect(evaluate(policy, { action: "s3:ListBucket", resource: bucketArn(intent.bucket), context: { "s3:prefix": intent.prefix } })).toBe(true);
    expect(evaluate(policy, { action: "s3:ListBucket", resource: bucketArn(intent.bucket), context: { "s3:prefix": key("sub/dir/") } })).toBe(true);
    expect(evaluate(policy, { action: "s3:GetBucketLocation", resource: bucketArn(intent.bucket) })).toBe(true);
  });

  it("denies another tenant's objects, a sibling prefix, the bucket root and other buckets", () => {
    const other = intentOf({ ...TENANT, workspaceId: "ws_other", environmentId: "env_other" });
    expect(other.prefix).not.toBe(intent.prefix);
    for (const action of ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]) {
      expect(evaluate(policy, { action, resource: objectArn(intent.bucket, `${other.prefix}x`) }), `${action} other tenant`).toBe(false);
      expect(evaluate(policy, { action, resource: objectArn(intent.bucket, "x") }), `${action} root`).toBe(false);
      expect(evaluate(policy, { action, resource: objectArn("some-other-bucket", key("x")) }), `${action} other bucket`).toBe(false);
    }
    // a sibling store whose name merely starts with this one's
    const sibling = intent.prefix.replace(/\/$/, "2/");
    expect(evaluate(policy, { action: "s3:GetObject", resource: objectArn(intent.bucket, `${sibling}x`) })).toBe(false);
    // the parent directories of the prefix
    expect(evaluate(policy, { action: "s3:GetObject", resource: objectArn(intent.bucket, intent.prefix.split("/").slice(0, 2).join("/") + "/x") })).toBe(false);
  });

  it("only lets the credential list when the request names its own prefix", () => {
    const list = (prefix: string | undefined) => evaluate(policy, { action: "s3:ListBucket", resource: bucketArn(intent.bucket), context: prefix === undefined ? {} : { "s3:prefix": prefix } });
    expect(list(undefined)).toBe(false);
    expect(list("")).toBe(false);
    expect(list("tenants/")).toBe(false);
    expect(list(intent.prefix.split("/").slice(0, 2).join("/") + "/")).toBe(false);
    expect(list(intent.prefix.replace(/\/$/, ""))).toBe(false);
    expect(list(`${intent.prefix.replace(/\/$/, "")}2/`)).toBe(false);
    expect(evaluate(policy, { action: "s3:ListBucketMultipartUploads", resource: bucketArn(intent.bucket), context: { "s3:prefix": "tenants/" } })).toBe(false);
  });

  it("grants no administrative, ACL, policy, bucket or IAM action", () => {
    for (const action of ["s3:*", "s3:PutBucketPolicy", "s3:DeleteBucket", "s3:PutBucketAcl", "s3:PutObjectAcl", "s3:GetBucketPolicy", "s3:PutLifecycleConfiguration", "s3:ListAllMyBuckets", "iam:CreateAccessKey", "sts:AssumeRole"]) {
      expect(evaluate(policy, { action, resource: objectArn(intent.bucket, key("x")) }), action).toBe(false);
      expect(evaluate(policy, { action, resource: bucketArn(intent.bucket), context: { "s3:prefix": intent.prefix } }), `${action} on bucket`).toBe(false);
    }
    expect(policy.Statement.every((s) => s.Effect === "Allow")).toBe(true);
    expect(JSON.stringify(policy)).not.toMatch(/"\*"|:\*"/);
  });

  it("has a stable digest that changes with the prefix or the bucket", () => {
    expect(policyDigest(scopedStoragePolicy(intent.bucket, intent.prefix))).toBe(policyDigest(policy));
    expect(policyDigest(scopedStoragePolicy(intent.bucket, `${intent.prefix}sub/`))).not.toBe(policyDigest(policy));
    expect(policyDigest(scopedStoragePolicy("another-bucket", intent.prefix))).not.toBe(policyDigest(policy));
  });

  it.each([
    "", "/", "a/", "a/b/", "/a/b/c/", "a//b/c/", "a/b/c", "a/../b/c/", "a/./b/c/", "a/*/c/", "a/b?/c/", "a/{x}/c/", "a/b/c d/", "a/b/$c/", "tenants/ws/",
  ])("refuses the prefix %j", (prefix) => {
    expect(() => assertScopedPrefix(prefix)).toThrow();
  });

  it("refuses a bucket name that could alter the resource ARN", () => {
    for (const bucket of ["UPPER", "a*b", "a/b", "x", "../x"]) expect(() => scopedStoragePolicy(bucket, "tenants/a/b/c/")).toThrow();
  });
});

describe("per-tenant intents", () => {
  it("derives a stable, id-free principal and a prefix under the tenant's reserved location", () => {
    const a = intentOf();
    expect(intentOf()).toEqual(a);
    expect(a.prefix).toMatch(/^tenants\/ws_7f3a9c\/env_b12e04\/[a-z0-9._~-]+\/$/);
    expect(a.principalName).toMatch(/^zenith-t-[0-9a-f]{24}$/);
    expect(a.principalName).not.toContain("ws_7f3a9c");
    expect(a.keyIdRef).toBe(storageKeyIdRef(TENANT.environmentId, OS.address));
    expect(a.secretRef).toBe(storageSecretRef(TENANT.environmentId, OS.address));
    expect(a.endpoint).toBe(sub.objectStorage!.endpoint);
  });

  it("separates tenants, environments and stores", () => {
    const base = intentOf();
    const otherWs = intentOf({ ...TENANT, workspaceId: "ws_zzz" });
    const otherEnv = intentOf({ ...TENANT, environmentId: "env_zzz" });
    const otherStore = intentOf(TENANT, mkNode("object_store/uploads", "object_store", {}));
    const all = [base, otherWs, otherEnv, otherStore];
    expect(new Set(all.map((i) => i.prefix)).size).toBe(4);
    expect(new Set(all.map((i) => i.principalName)).size).toBe(4);
    expect(principalNameFor(TENANT, "object_store/media")).toBe(base.principalName);
  });

  it("never lets a hostile id widen the prefix", () => {
    for (const id of ["../../other", "ws/../x", "a*b", "ws id", "", "x".repeat(300)]) {
      const i = intentOf({ ...TENANT, workspaceId: id, environmentId: id });
      expect(() => assertScopedPrefix(i.prefix)).not.toThrow();
      expect(i.prefix.startsWith("tenants/")).toBe(true);
      expect(i.prefix).not.toMatch(/\.\.|\*|\/\//);
    }
    const hostileAddress = intentOf(TENANT, mkNode("object_store/../../x*", "object_store", {}));
    expect(hostileAddress.prefix).not.toMatch(/\.\.|\*|\/\//);
  });

  it("uses vault references the workload resolver accepts, and only for its own environment", () => {
    const i = intentOf();
    const scope = { workspaceId: TENANT.workspaceId, projectId: "proj_1", environmentId: TENANT.environmentId, resourceAddresses: [OS.address] };
    expect(assertVaultScope(i.keyIdRef, scope)).toBe("storage-key-id");
    expect(assertVaultScope(i.secretRef, scope)).toBe("storage-secret");
    expect(() => assertVaultScope(i.secretRef, { ...scope, environmentId: "env_other" })).toThrow();
    expect(() => assertVaultScope(i.secretRef, { ...scope, resourceAddresses: ["object_store/other"] })).toThrow();
  });

  it("gives the workload the credential halves as references and the rest as plain values", () => {
    const env = storageWorkloadEnv(intentOf());
    expect(env.find((e) => e.key === "AWS_ACCESS_KEY_ID")).toEqual({ key: "AWS_ACCESS_KEY_ID", secretRef: expect.stringMatching(/^vault:/) });
    expect(env.find((e) => e.key === "AWS_SECRET_ACCESS_KEY")).toEqual({ key: "AWS_SECRET_ACCESS_KEY", secretRef: expect.stringMatching(/^vault:/) });
    expect(env.find((e) => e.key === "S3_PREFIX")).toMatchObject({ value: intentOf().prefix });
    expect(env.filter((e) => "value" in e).every((e) => !("secretRef" in e))).toBe(true);
  });

  it("refuses an environment with no object storage configured", () => {
    const none = substrate({ ...FULL_ENV, ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT: "", ZENITH_MANAGED_OBJECT_STORAGE_BUCKET: "", ZENITH_MANAGED_OBJECT_STORAGE_CREDENTIAL_REF: "" });
    expect(() => storageIntentFromNode(TENANT, none, OS)).toThrow(/not configured/);
  });
});

describe("provisioning lifecycle", () => {
  const setup = () => ({ admin: new FakeAdmin(), sink: new MemorySink(), store: new MemoryKeyStore() });
  const run = (s: ReturnType<typeof setup>, intents: ManagedStorageIntent[] = [intentOf()], opts: { dryRun?: boolean } = {}) =>
    provisionObjectStores(intents, { admin: s.admin, sink: s.sink, store: s.store }, opts);

  it("creates one scoped principal and key, writes both halves to the vault and records only references", async () => {
    const s = setup();
    const intent = intentOf();
    const [out] = await run(s);
    expect(out).toMatchObject({ status: "created", bucket: intent.bucket, prefix: intent.prefix, keyIdRef: intent.keyIdRef, secretRef: intent.secretRef });
    const principal = s.admin.principals.get(intent.principalName)!;
    expect(policyDigest(principal.policy!)).toBe(intent.policyDigest);
    expect(principal.keys.size).toBe(1);
    const [keyId, secret] = [...principal.keys.entries()][0];
    expect(s.sink.values.get(intent.keyIdRef)).toBe(keyId);
    expect(s.sink.values.get(intent.secretRef)).toBe(secret);
    expect(s.store.rows).toHaveLength(1);
    expect(s.store.rows[0]).toMatchObject({ status: "active", accessKeyId: keyId, secretRef: intent.secretRef, prefix: intent.prefix });
    // nothing that leaves the function, and nothing stored, carries the secret
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(JSON.stringify(s.store.rows)).not.toContain(secret);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const s = setup();
    await run(s);
    const before = s.admin.calls.filter((c) => c === "createAccessKey").length;
    const [again] = await run(s);
    expect(again.status).toBe("exists");
    expect(s.admin.calls.filter((c) => c === "createAccessKey").length).toBe(before);
    expect(s.store.rows).toHaveLength(1);
  });

  it("converges a principal whose policy was changed behind our back", async () => {
    const s = setup();
    const intent = intentOf();
    await run(s);
    s.admin.principals.get(intent.principalName)!.policy = scopedStoragePolicy(intent.bucket, "tenants/everyone/shared/all/");
    await run(s);
    expect(policyDigest(s.admin.principals.get(intent.principalName)!.policy!)).toBe(intent.policyDigest);
  });

  it("rotates when the scope changes: new key first, then the old key is revoked at the provider", async () => {
    const s = setup();
    const first = intentOf();
    await run(s);
    const oldKey = s.store.rows[0].accessKeyId;
    const moved = { ...first, prefix: `${first.prefix}v2/`, policyDigest: policyDigest(scopedStoragePolicy(first.bucket, `${first.prefix}v2/`)) };
    const [out] = await run(s, [moved]);
    expect(out.status).toBe("rotated");
    const principal = s.admin.principals.get(first.principalName)!;
    expect(principal.keys.has(oldKey)).toBe(false);
    expect(principal.keys.size).toBe(1);
    expect(s.store.rows.map((r) => r.status).sort()).toEqual(["active", "revoked"]);
    expect(s.store.rows.find((r) => r.status === "active")!.prefix).toBe(moved.prefix);
    // the vault now holds the new key's halves
    expect(s.sink.values.get(first.keyIdRef)).toBe([...principal.keys.keys()][0]);
  });

  it("re-creates the credential when the vault lost it", async () => {
    const s = setup();
    await run(s);
    s.sink.values.clear();
    const [out] = await run(s);
    expect(out.status).toBe("rotated");
    expect(s.sink.values.size).toBe(2);
  });

  it("discards a key it could not store: a vault failure leaves no unmanaged credential", async () => {
    const s = setup();
    s.sink.failPuts = true;
    const [out] = await run(s);
    expect(out).toMatchObject({ status: "failed", error: { code: "unavailable" } });
    expect(s.admin.principals.get(intentOf().principalName)!.keys.size).toBe(0);
    expect(s.store.rows).toEqual([]);
  });

  it("removes an orphan key the store never recorded (a crash between create and record)", async () => {
    const s = setup();
    const intent = intentOf();
    await run(s);
    const orphan = (await s.admin.createAccessKey(intent.principalName)) as { ok: true; value: { accessKeyId: string } };
    expect(s.admin.principals.get(intent.principalName)!.keys.size).toBe(2);
    await run(s);
    expect(s.admin.principals.get(intent.principalName)!.keys.has(orphan.value.accessKeyId)).toBe(false);
    expect(s.admin.principals.get(intent.principalName)!.keys.size).toBe(1);
  });

  it("keeps an unrevoked old key pending and settles it later; it never creates a third key", async () => {
    const s = setup();
    const first = intentOf();
    await run(s);
    const oldKey = s.store.rows[0].accessKeyId;
    s.admin.failDeletes = 5;
    const moved = { ...first, prefix: `${first.prefix}v2/`, policyDigest: policyDigest(scopedStoragePolicy(first.bucket, `${first.prefix}v2/`)) };
    const [rotated] = await run(s, [moved]);
    expect(rotated.status).toBe("rotated");
    expect(s.store.rows.find((r) => r.accessKeyId === oldKey)!.status).toBe("revoke_pending");
    expect(s.admin.principals.get(first.principalName)!.keys.size).toBe(2);

    // another change while the old key is still owed: no room for a third key, so it is refused, not forced
    const moved2 = { ...first, prefix: `${first.prefix}v3/`, policyDigest: policyDigest(scopedStoragePolicy(first.bucket, `${first.prefix}v3/`)) };
    const [blocked] = await run(s, [moved2]);
    expect(blocked).toMatchObject({ status: "failed", error: { code: "conflict", retryable: true } });
    expect(s.admin.principals.get(first.principalName)!.keys.size).toBe(2);

    s.admin.failDeletes = 0;
    const settled = await settleRevocations(first.principalName, first.address, { admin: s.admin, store: s.store });
    expect(settled).toEqual({ revoked: 1, owed: 0 });
    expect(s.store.rows.find((r) => r.accessKeyId === oldKey)!.status).toBe("revoked");
    expect(s.admin.principals.get(first.principalName)!.keys.has(oldKey)).toBe(false);
  });

  it("retiring an object store revokes its credential and touches nothing else", async () => {
    const s = setup();
    const intent = intentOf();
    await run(s);
    const keyId = s.store.rows[0].accessKeyId;
    const result = await revokeObjectStoreKeys(intent.principalName, intent.address, {
      admin: s.admin, store: s.store, retire: async (address) => { const row = s.store.rows.find((r) => r.address === address && r.status === "active"); if (row) row.status = "revoke_pending"; },
    });
    expect(result).toEqual({ revoked: 1, owed: 0 });
    expect(s.admin.principals.get(intent.principalName)!.keys.has(keyId)).toBe(false);
    expect(s.admin.calls.filter((c) => c === "createAccessKey")).toHaveLength(1);
  });

  it("fails every store with the reason when the admin port is unavailable, and plans without calling it", async () => {
    const s = setup();
    s.admin.available = { available: false, reason: "needs the admin credential" };
    const [out] = await run(s);
    expect(out).toMatchObject({ status: "failed", error: { code: "unavailable", message: "needs the admin credential" } });
    expect(s.admin.calls).toEqual([]);

    const s2 = setup();
    const [planned] = await run(s2, [intentOf()], { dryRun: true });
    expect(planned.status).toBe("planned");
    expect(s2.admin.calls).toEqual([]);
    expect(s2.store.rows).toEqual([]);
    expect(s2.sink.puts).toEqual([]);

    const refused = refuseObjectStores([intentOf()], "no ports");
    expect(refused[0]).toMatchObject({ status: "failed", error: { code: "unavailable", message: "no ports" } });
    const un = unavailableStorageAdmin("x");
    expect((await un.createAccessKey("n")).ok).toBe(false);
  });

  it("stops at the first failure and marks the rest not attempted", async () => {
    const s = setup();
    s.admin.failCreate = true;
    const second = storageIntentFromNode(TENANT, sub, mkNode("object_store/uploads", "object_store", {}));
    const out = await run(s, [intentOf(), second]);
    expect(out.map((o) => o.status)).toEqual(["failed", "failed"]);
    expect(out[1].error).toMatchObject({ code: "aborted", retryable: true });
  });

  it("keeps two tenants' principals and keys apart", async () => {
    const s = setup();
    const a = intentOf();
    const b = intentOf({ ...TENANT, workspaceId: "ws_b", environmentId: "env_b" });
    await run(s, [a]);
    await provisionObjectStores([b], { admin: s.admin, sink: s.sink, store: new MemoryKeyStore("ws_b", "env_b") });
    expect(s.admin.principals.size).toBe(2);
    expect(evaluate(s.admin.principals.get(a.principalName)!.policy!, { action: "s3:GetObject", resource: objectArn(b.bucket, `${b.prefix}x`) })).toBe(false);
    expect(evaluate(s.admin.principals.get(b.principalName)!.policy!, { action: "s3:GetObject", resource: objectArn(a.bucket, `${a.prefix}x`) })).toBe(false);
  });
});

/* ------------------------------ the IAM adapter ----------------------------- */

interface Sent { name: string; input: Record<string, unknown> }

function fakeIam(handlers: Record<string, (input: Record<string, unknown>) => Record<string, unknown>>) {
  const sent: Sent[] = [];
  let destroyed = 0;
  const clients: { credentials?: unknown; endpoint?: string; region?: string }[] = [];
  const sdk: IamSdk = {
    createClient(input) {
      clients.push(input);
      const client: IamClientLike = {
        async send(command) {
          sent.push({ name: command.name, input: command.input });
          const h = handlers[command.name];
          if (!h) throw Object.assign(new Error("no handler"), { name: "ServiceFailure" });
          return h(command.input);
        },
        destroy() { destroyed++; },
      };
      return client;
    },
  };
  return { sdk, sent, clients, destroyed: () => destroyed };
}
const noSuchEntity = () => Object.assign(new Error("nope"), { name: "NoSuchEntityException", $metadata: { httpStatusCode: 404 } });
const ADMIN_CRED = JSON.stringify({ accessKeyId: "AKIAADMINEXAMPLE0001", secretAccessKey: "admin-secret-value", sessionToken: "tok" });
const config = { region: "us-east-1", endpoint: "https://iam.storage.example.com", credentialRef: "vault:zenith-managed/object-store-admin" };

describe("the brokered admin port", () => {
  it("runs every call inside a broker session and never sees a credential", async () => {
    const fake = fakeIam({ ListAccessKeys: () => ({ AccessKeyMetadata: [{ AccessKeyId: "AKIAONE" }] }), DeleteAccessKey: () => ({}) });
    let sessions = 0;
    const port = createBrokeredIamAdminPort(async (fn) => { sessions++; return fn(fake.sdk.createClient({ region: "us-east-1", credentials: { accessKeyId: "x", secretAccessKey: "y" } })); });
    expect(await port.listAccessKeys("u")).toEqual({ ok: true, value: ["AKIAONE"] });
    expect((await port.deleteAccessKey("u", "AKIAONE")).ok).toBe(true);
    expect(sessions).toBe(2);
  });

  it("reports a denied, revoked or unavailable session as unavailable, without the broker's text", async () => {
    const port = createBrokeredIamAdminPort(async () => { throw new CredentialDeniedError("connection conn_secret_123 was revoked by alice@example.com"); });
    const r = await port.deleteAccessKey("u", "AKIAONE");
    expect(r).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(r)).not.toMatch(/conn_secret_123|alice/);
  });
});

describe("the IAM adapter (contract, recording SDK)", () => {
  it("creates a tagged principal, puts exactly the scoped policy and resolves the credential from the vault per call", async () => {
    const intent = intentOf();
    const policy = scopedStoragePolicy(intent.bucket, intent.prefix);
    const fake = fakeIam({
      GetUser: () => { throw noSuchEntity(); },
      CreateUser: () => ({}),
      PutUserPolicy: () => ({}),
    });
    let resolved = 0;
    const port = createIamAdminPort(config, { resolveSecret: async (ref) => { resolved++; return ref === config.credentialRef ? ADMIN_CRED : undefined; }, loadSdk: async () => fake.sdk });
    const r = await port.ensurePrincipal({ name: intent.principalName, policy });
    expect(r).toEqual({ ok: true, value: { created: true } });
    expect(fake.sent.map((s) => s.name)).toEqual(["GetUser", "CreateUser", "PutUserPolicy"]);
    expect(fake.sent[1].input).toMatchObject({ UserName: intent.principalName, Tags: [{ Key: "zenith-managed", Value: "tenant-object-store" }] });
    const put = fake.sent[2].input as { PolicyName: string; PolicyDocument: string };
    expect(put.PolicyName).toBe("zenith-prefix-scope");
    expect(policyDigest(JSON.parse(put.PolicyDocument))).toBe(intent.policyDigest);
    expect(fake.clients[0]).toMatchObject({ region: "us-east-1", endpoint: "https://iam.storage.example.com", credentials: { accessKeyId: "AKIAADMINEXAMPLE0001" } });
    expect(fake.destroyed()).toBe(1);
    expect(resolved).toBe(1);
    await port.listAccessKeys("x").catch(() => undefined);
    expect(resolved).toBe(2);
  });

  it("converges an existing principal Zenith created and refuses one it did not", async () => {
    const intent = intentOf();
    const policy = scopedStoragePolicy(intent.bucket, intent.prefix);
    const ours = fakeIam({ GetUser: () => ({}), ListUserTags: () => ({ Tags: [{ Key: "zenith-managed", Value: "tenant-object-store" }] }), PutUserPolicy: () => ({}) });
    const a = createIamAdminPort(config, { resolveSecret: async () => ADMIN_CRED, loadSdk: async () => ours.sdk });
    expect(await a.ensurePrincipal({ name: intent.principalName, policy })).toEqual({ ok: true, value: { created: false } });
    expect(ours.sent.map((s) => s.name)).toEqual(["GetUser", "ListUserTags", "PutUserPolicy"]);

    const foreign = fakeIam({ GetUser: () => ({}), ListUserTags: () => ({ Tags: [] }), PutUserPolicy: () => ({}) });
    const b = createIamAdminPort(config, { resolveSecret: async () => ADMIN_CRED, loadSdk: async () => foreign.sdk });
    const refused = await b.ensurePrincipal({ name: "someone-elses-user", policy });
    expect(refused).toMatchObject({ ok: false, error: { code: "conflict", retryable: false } });
    expect(foreign.sent.map((s) => s.name)).not.toContain("PutUserPolicy");
  });

  it("reads back the policy digest the provider holds (IAM returns the document URL-encoded)", async () => {
    const intent = intentOf();
    const policy = scopedStoragePolicy(intent.bucket, intent.prefix);
    const fake = fakeIam({ GetUserPolicy: () => ({ PolicyDocument: encodeURIComponent(JSON.stringify(policy)) }) });
    const port = createIamAdminPort(config, { resolveSecret: async () => ADMIN_CRED, loadSdk: async () => fake.sdk });
    expect(await port.readPolicyDigest(intent.principalName)).toEqual({ ok: true, value: intent.policyDigest });
    const none = fakeIam({ GetUserPolicy: () => { throw noSuchEntity(); } });
    const port2 = createIamAdminPort(config, { resolveSecret: async () => ADMIN_CRED, loadSdk: async () => none.sdk });
    expect(await port2.readPolicyDigest("x")).toEqual({ ok: true, value: undefined });
  });

  it("creates, lists and deletes keys, treating an absent key as already deleted", async () => {
    const fake = fakeIam({
      CreateAccessKey: () => ({ AccessKey: { AccessKeyId: "AKIANEW", SecretAccessKey: "new-secret" } }),
      ListAccessKeys: () => ({ AccessKeyMetadata: [{ AccessKeyId: "AKIAONE" }, { AccessKeyId: "AKIATWO" }] }),
      DeleteAccessKey: (i) => { if (i.AccessKeyId === "AKIAGONE") throw noSuchEntity(); return {}; },
    });
    const port = createIamAdminPort(config, { resolveSecret: async () => ADMIN_CRED, loadSdk: async () => fake.sdk });
    expect(await port.createAccessKey("u")).toEqual({ ok: true, value: { accessKeyId: "AKIANEW", secretAccessKey: "new-secret" } });
    expect(await port.listAccessKeys("u")).toEqual({ ok: true, value: ["AKIAONE", "AKIATWO"] });
    expect((await port.deleteAccessKey("u", "AKIAONE")).ok).toBe(true);
    expect((await port.deleteAccessKey("u", "AKIAGONE")).ok).toBe(true);
  });

  it("maps provider failures to fixed codes without echoing provider text or credentials", async () => {
    const cases: [Error, string][] = [
      [Object.assign(new Error("User: arn:aws:iam::123456789012:user/admin is not authorized AKIAADMINEXAMPLE0001"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }), "forbidden"],
      [Object.assign(new Error("Rate exceeded"), { name: "Throttling" }), "throttled"],
      [Object.assign(new Error("Cannot exceed quota for AccessKeysPerUser: 2"), { name: "LimitExceeded" }), "conflict"],
      [Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:443"), { name: "ECONNREFUSED" }), "unreachable"],
      [Object.assign(new Error("boom with admin-secret-value"), { name: "ServiceFailure" }), "provider_error"],
    ];
    for (const [error, code] of cases) {
      const fake = fakeIam({ CreateAccessKey: () => { throw error; } });
      const port = createIamAdminPort(config, { resolveSecret: async () => ADMIN_CRED, loadSdk: async () => fake.sdk });
      const r = await port.createAccessKey("u");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe(code);
        expect(JSON.stringify(r)).not.toMatch(/admin-secret-value|AKIAADMINEXAMPLE0001|123456789012|10\.1\.2\.3/);
      }
      expect(fake.destroyed()).toBe(1);
    }
  });

  it("is unavailable, naming the variable to set, when there is no admin credential or it cannot be read", async () => {
    const none = createIamAdminPort(undefined, { resolveSecret: async () => ADMIN_CRED });
    expect(none.availability()).toMatchObject({ available: false, reason: expect.stringContaining("ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF") });
    expect(await none.createAccessKey("u")).toMatchObject({ ok: false, error: { code: "unavailable" } });

    for (const value of [undefined, "", "not json", JSON.stringify({ accessKeyId: 1 })]) {
      const fake = fakeIam({});
      const port = createIamAdminPort(config, { resolveSecret: async () => value, loadSdk: async () => fake.sdk });
      const r = await port.listAccessKeys("u");
      expect(r).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(fake.sent).toEqual([]);
    }
  });

  it("honors cancellation before any call", async () => {
    const fake = fakeIam({ ListAccessKeys: () => ({ AccessKeyMetadata: [] }) });
    const port = createIamAdminPort(config, { resolveSecret: async () => ADMIN_CRED, loadSdk: async () => fake.sdk });
    const abort = new AbortController();
    abort.abort();
    const r = await port.listAccessKeys("u", { signal: abort.signal });
    expect(r.ok).toBe(false);
    expect(fake.sent).toEqual([]);
  });
});
