/**
 * Pure policy and orchestration for tenant-scoped Kubernetes guest credentials
 * (PROD-MACH-02). The cluster and the store are MODELS here (in-memory ports that
 * record calls); they prove the refusal logic, never a real API server. The real
 * cluster is exercised by tests/machines/kubernetes-guest-scoped-kind.test.ts and
 * the real store by tests/controlplane/k8s-guest-bindings.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  GuestCredentialError, SYSTEM_NAMESPACES, assertGuestNamespace, assertGuestTokenClaims, buildGuestKubeConfig, decodeGuestTokenClaims,
  guestHash, guestLabels, guestObjectName, guestProfileFor, guestRoleRules, mintGuestCredential, revokeGuestBindings, verifyGuestMinter,
  type AccessAttributes, type GuestBindingRef, type GuestClusterPort, type GuestStorePort,
} from "@/lib/providers/kubernetes/guest";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const WS = "ws-a", CONN = "conn-a";

function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.${Buffer.from("signature-bytes").toString("base64url")}`;
}

function cluster(over: Partial<{ allow: (a: AccessAttributes) => boolean; claims: (ns: string, name: string, uid: string, ttl: number) => Record<string, unknown>; failToken: boolean }> = {}) {
  const calls: string[] = [];
  const port: GuestClusterPort = {
    async allowed(a) { calls.push(`allowed:${a.verb}:${a.group}:${a.resource}${a.subresource ? "/" + a.subresource : ""}:${a.namespace ?? ""}`); return over.allow ? over.allow(a) : isRequired(a); },
    async ensureServiceAccount(ns, name) { calls.push(`sa:${ns}:${name}`); return { uid: `uid-${name}` }; },
    async ensureRole(ns, name, _labels, rules) { calls.push(`role:${ns}:${name}:${JSON.stringify(rules)}`); },
    async ensureRoleBinding(ns, name, _labels, sa) { calls.push(`rb:${ns}:${name}:${sa}`); },
    async requestToken(ns, name, uid, audiences, ttl) {
      calls.push(`token:${ns}:${name}:${ttl}`);
      if (over.failToken) throw new GuestCredentialError("cluster_error");
      const claims = over.claims ? over.claims(ns, name, uid, ttl) : {
        sub: `system:serviceaccount:${ns}:${name}`, aud: audiences.length ? audiences : ["https://kubernetes.default.svc"], exp: Math.floor(NOW / 1000) + ttl, "kubernetes.io": { serviceaccount: { name, uid } },
      };
      return { token: jwt(claims), expiresAt: new Date(NOW + ttl * 1000).toISOString() };
    },
    async deleteGuestObjects(ns, name, hash) { calls.push(`delete:${ns}:${name}:${hash}`); },
  };
  return { port, calls };
}
/** The minter holds exactly what guest provisioning needs, in namespaced scope only. */
const isRequired = (a: AccessAttributes) => !!a.namespace && a.namespace !== "kube-system" && a.verb !== "*";

function store(over: Partial<{ revokedAfterEnsure: boolean; issuance: boolean; status: GuestBindingRef["status"]; absent: boolean }> = {}) {
  const rows = new Map<string, GuestBindingRef & { error?: string }>();
  const events: string[] = [];
  const port: GuestStorePort = {
    async ensureBinding(input) {
      if (over.absent) return null;
      const key = `${input.namespace}/${input.profile}`;
      if (!rows.has(key)) rows.set(key, { id: `b-${key}`, status: over.status ?? "provisioning", namespace: input.namespace, profile: input.profile, objectName: input.objectName });
      return rows.get(key)!;
    },
    async markActive(id) {
      const row = [...rows.values()].find((r) => r.id === id)!;
      if (over.revokedAfterEnsure) { row.status = "revoking"; return null; }
      row.status = "active"; return row;
    },
    async recordIssuance(id) { events.push(`issued:${id}`); return over.issuance ?? true; },
    async recordError(id, code) { const row = [...rows.values()].find((r) => r.id === id); if (row) row.error = code; events.push(`error:${code}`); },
    async markRevoking(id) { const row = [...rows.values()].find((r) => r.id === id); if (!row || row.status === "revoked") return false; row.status = "revoking"; return true; },
    async markRevoked(id) { const row = [...rows.values()].find((r) => r.id === id); if (!row) return false; row.status = "revoked"; return true; },
    async listOpen() { return [...rows.values()].filter((r) => r.status !== "revoked"); },
  };
  return { port, rows, events };
}

const request = (over: Record<string, unknown> = {}) => ({ workspaceId: WS, connectionId: CONN, namespace: "app", profile: "read" as const, namespaces: ["app", "other"], ...over });
const refusal = async (p: Promise<unknown>) => { const e = await p.then(() => undefined, (x: unknown) => x); expect(e).toBeInstanceOf(GuestCredentialError); return e as GuestCredentialError; };

describe("guest object policy", () => {
  it("names and labels are tenant-and-connection specific, opaque and DNS-safe", () => {
    const a = guestObjectName(WS, CONN, "read"), b = guestObjectName(WS, "conn-b", "read"), c = guestObjectName("ws-b", CONN, "read");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).toMatch(/^zg-[0-9a-f]{16}-read$/);
    expect(guestObjectName(WS, CONN, "exec")).toMatch(/-exec$/);
    expect(JSON.stringify(guestLabels(WS, CONN, "read"))).not.toContain(WS);
    expect(JSON.stringify(guestLabels(WS, CONN, "read"))).not.toContain(CONN);
    expect(guestLabels(WS, CONN, "read")["zenith.dev/guest-hash"]).toBe(guestHash(WS, CONN));
  });
  it("roles are exact, namespaced-by-construction and never reach secrets, wildcards or workload writes", () => {
    for (const profile of ["read", "exec"] as const) {
      const rules = guestRoleRules(profile);
      const flat = JSON.stringify(rules);
      expect(flat).not.toContain("*");
      expect(flat).not.toContain("secrets");
      for (const rule of rules) {
        expect(rule.apiGroups).toEqual([""]);
        expect(rule.verbs?.some((v) => ["create", "update", "patch", "delete", "deletecollection", "impersonate", "bind", "escalate"].includes(v)) ?? false).toBe(rule.resources?.[0] === "pods/exec");
      }
    }
    expect(guestRoleRules("read").map((r) => r.resources![0])).toEqual(["pods", "pods/log"]);
    expect(guestRoleRules("exec").map((r) => r.resources![0])).toEqual(["pods", "pods/log", "pods/exec"]);
  });
  it("maps operations to the smallest profile", () => {
    for (const op of ["container.list", "container.inspect", "container.logs"]) expect(guestProfileFor(op)).toBe("read");
    for (const op of ["container.exec", "process.list", "file.read", "anything.else"]) expect(guestProfileFor(op)).toBe("exec");
  });
  it("refuses system, foreign and malformed namespaces", () => {
    for (const ns of [...SYSTEM_NAMESPACES, "not-listed", "Bad_Name", "", "a/b"]) expect(() => assertGuestNamespace(ns, ["kube-system", "app"])).toThrow(GuestCredentialError);
    expect(() => assertGuestNamespace("app", ["app"])).not.toThrow();
  });
});

describe("minter scope", () => {
  it.each([
    ["cluster-wide wildcard", (a: AccessAttributes) => a.verb === "*" && a.resource === "*"],
    ["cluster role bindings", (a: AccessAttributes) => a.resource === "clusterrolebindings"],
    ["kube-system secrets", (a: AccessAttributes) => a.resource === "secrets" && a.namespace === "kube-system"],
    ["kube-system exec", (a: AccessAttributes) => a.subresource === "exec" && a.namespace === "kube-system"],
  ])("refuses a minter that holds %s, before touching any object", async (_name, hit) => {
    const c = cluster({ allow: (a) => hit(a) || isRequired(a) }), s = store();
    const e = await refusal(mintGuestCredential({ cluster: c.port, store: s.port, now: () => new Date(NOW) }, request()));
    expect(e.code).toBe("minter_overprivileged");
    expect(c.calls.some((x) => x.startsWith("sa:") || x.startsWith("role:") || x.startsWith("token:"))).toBe(false);
    expect(s.rows.size).toBe(0);
  });
  it("refuses a minter that cannot manage guest objects in the namespace", async () => {
    const c = cluster({ allow: (a) => isRequired(a) && !(a.resource === "roles" && a.verb === "create") }), s = store();
    expect((await refusal(mintGuestCredential({ cluster: c.port, store: s.port }, request()))).code).toBe("minter_insufficient");
    expect(c.calls.some((x) => x.startsWith("token:"))).toBe(false);
    expect([...s.rows.values()][0].error).toBe("minter_insufficient");
  });
  it("verification checks every allowlisted namespace and rejects system namespaces and empty lists", async () => {
    await expect(verifyGuestMinter(cluster().port, ["app", "other"])).resolves.toBeUndefined();
    expect((await refusal(verifyGuestMinter(cluster().port, []))).code).toBe("scope_refused");
    expect((await refusal(verifyGuestMinter(cluster().port, ["app", "kube-system"]))).code).toBe("scope_refused");
    expect((await refusal(verifyGuestMinter(cluster({ allow: (a) => isRequired(a) && a.namespace !== "other" }).port, ["app", "other"]))).code).toBe("minter_insufficient");
  });
});

describe("minting", () => {
  it("mints a claim-checked, short-lived token for exactly one namespace and profile", async () => {
    const c = cluster(), s = store();
    const out = await mintGuestCredential({ cluster: c.port, store: s.port, now: () => new Date(NOW) }, request({ profile: "exec" }));
    const name = guestObjectName(WS, CONN, "exec");
    expect(out.serviceAccount).toBe(name);
    expect(Date.parse(out.expiresAt)).toBe(NOW + 600_000);
    expect(c.calls).toContain(`token:app:${name}:600`);
    expect(c.calls.find((x) => x.startsWith("role:"))).toContain("pods/exec");
    expect(c.calls.filter((x) => x.startsWith("sa:") || x.startsWith("rb:")).every((x) => x.includes(":app:"))).toBe(true);
    expect(s.rows.get("app/exec")!.status).toBe("active");
    expect(s.events).toEqual([`issued:b-app/exec`]);
  });
  it("binds the requested audiences and clamps the lifetime to the TokenRequest range", async () => {
    const c = cluster();
    await mintGuestCredential({ cluster: c.port, store: store().port, now: () => new Date(NOW) }, request({ audiences: ["https://api.example.test"], tokenTtlSec: 5 }));
    expect(c.calls.some((x) => x.endsWith(":600"))).toBe(true);
    const long = cluster();
    await mintGuestCredential({ cluster: long.port, store: store().port, now: () => new Date(NOW) }, request({ tokenTtlSec: 999_999 }));
    expect(long.calls.some((x) => x.endsWith(":3600"))).toBe(true);
    const wrong = cluster({ claims: (ns, name, uid, ttl) => ({ sub: `system:serviceaccount:${ns}:${name}`, aud: ["https://other.example.test"], exp: Math.floor(NOW / 1000) + ttl, "kubernetes.io": { serviceaccount: { uid } } }) });
    expect((await refusal(mintGuestCredential({ cluster: wrong.port, store: store().port, now: () => new Date(NOW) }, request({ audiences: ["https://api.example.test"] })))).code).toBe("token_invalid");
  });
  it("refuses a token for the wrong subject, uid, audience or lifetime and never returns it", async () => {
    const base = (ns: string, name: string, uid: string, ttl: number) => ({ sub: `system:serviceaccount:${ns}:${name}`, aud: ["a"], exp: Math.floor(NOW / 1000) + ttl, "kubernetes.io": { serviceaccount: { uid } } });
    const bad: Array<[string, (ns: string, name: string, uid: string, ttl: number) => Record<string, unknown>]> = [
      ["subject", (ns, n, u, t) => ({ ...base(ns, n, u, t), sub: "system:serviceaccount:app:other" })],
      ["foreign namespace", (_ns, n, u, t) => ({ ...base("kube-system", n, u, t) })],
      ["uid", (ns, n, _u, t) => base(ns, n, "different-uid", t)],
      ["no audience", (ns, n, u, t) => ({ ...base(ns, n, u, t), aud: [] })],
      ["expired", (ns, n, u) => ({ ...base(ns, n, u, 0), exp: Math.floor(NOW / 1000) - 5 })],
      ["too long", (ns, n, u) => ({ ...base(ns, n, u, 0), exp: Math.floor(NOW / 1000) + 86_400 })],
    ];
    for (const [, claims] of bad) {
      const s = store();
      expect((await refusal(mintGuestCredential({ cluster: cluster({ claims }).port, store: s.port, now: () => new Date(NOW) }, request()))).code).toBe("token_invalid");
      expect(s.events.some((x) => x.startsWith("issued"))).toBe(false);
    }
    expect(() => decodeGuestTokenClaims("not-a-jwt")).toThrow(GuestCredentialError);
    expect(() => assertGuestTokenClaims("a.b.c", { namespace: "app", serviceAccount: "x", uid: "u", audiences: [], nowMs: NOW, maxLifetimeSec: 600 })).toThrow(GuestCredentialError);
  });
  it("a revoking/revoked binding, an absent or revoked connection, or a race with revocation refuses without a token", async () => {
    for (const s of [store({ status: "revoking" }), store({ status: "revoked" }), store({ absent: true })]) {
      const c = cluster();
      expect((await refusal(mintGuestCredential({ cluster: c.port, store: s.port }, request()))).code).toBe("binding_revoked");
      expect(c.calls.some((x) => x.startsWith("token:") || x.startsWith("sa:"))).toBe(false);
    }
    const raced = store({ revokedAfterEnsure: true }), c1 = cluster();
    expect((await refusal(mintGuestCredential({ cluster: c1.port, store: raced.port }, request()))).code).toBe("binding_revoked");
    expect(c1.calls.some((x) => x.startsWith("token:"))).toBe(false);
    // The token WAS requested but revocation landed before the issuance record: it is discarded.
    const late = store({ issuance: false }), c2 = cluster();
    expect((await refusal(mintGuestCredential({ cluster: c2.port, store: late.port, now: () => new Date(NOW) }, request()))).code).toBe("binding_revoked");
  });
  it("an unrelated cluster failure is an explicit refusal, not a fallback", async () => {
    const s = store();
    expect((await refusal(mintGuestCredential({ cluster: cluster({ failToken: true }).port, store: s.port }, request()))).code).toBe("cluster_error");
    expect(s.rows.get("app/read")!.error).toBe("cluster_error");
    const thrower: GuestClusterPort = { ...cluster().port, ensureServiceAccount: async () => { throw new Error("raw provider text with Bearer secret-token-canary"); } };
    const e = await refusal(mintGuestCredential({ cluster: thrower, store: store().port }, request()));
    expect(e.code).toBe("cluster_error");
    expect(e.message).not.toContain("canary");
  });
  it("refuses unknown profiles, system namespaces and namespaces outside the allowlist before any call", async () => {
    for (const over of [{ profile: "admin" }, { namespace: "kube-system" }, { namespace: "elsewhere" }]) {
      const c = cluster();
      expect((await refusal(mintGuestCredential({ cluster: c.port, store: store().port }, request(over)))).code).toBe("scope_refused");
      expect(c.calls).toEqual([]);
    }
  });
  it("the guest kubeconfig carries only the guest token and the connection's server", () => {
    const kc = buildGuestKubeConfig({ server: "https://cluster.example.test/", caData: Buffer.from("ca").toString("base64"), token: "guest-token-value" });
    expect(kc.getCurrentUser()?.token).toBe("guest-token-value");
    expect(kc.getCurrentCluster()?.server).toBe("https://cluster.example.test");
    expect(() => buildGuestKubeConfig({ server: "http://cluster.example.test", token: "x" })).toThrow();
  });
});

describe("revocation", () => {
  it("deletes every open binding's objects with the tenant hash guard and marks them revoked", async () => {
    const s = store(), c = cluster();
    await mintGuestCredential({ cluster: c.port, store: s.port, now: () => new Date(NOW) }, request());
    await mintGuestCredential({ cluster: c.port, store: s.port, now: () => new Date(NOW) }, request({ profile: "exec", namespace: "other" }));
    expect(await revokeGuestBindings({ cluster: c.port, store: s.port }, { workspaceId: WS, connectionId: CONN })).toEqual({ revoked: 2, pending: 0 });
    expect(c.calls.filter((x) => x.startsWith("delete:"))).toEqual([
      `delete:app:${guestObjectName(WS, CONN, "read")}:${guestHash(WS, CONN)}`,
      `delete:other:${guestObjectName(WS, CONN, "exec")}:${guestHash(WS, CONN)}`,
    ]);
    expect([...s.rows.values()].map((r) => r.status)).toEqual(["revoked", "revoked"]);
    expect(await revokeGuestBindings({ cluster: c.port, store: s.port }, { workspaceId: WS, connectionId: CONN })).toEqual({ revoked: 0, pending: 0 });
  });
  it("a deletion failure leaves the binding revoking (still unmintable) and is retried", async () => {
    const s = store(), c = cluster();
    await mintGuestCredential({ cluster: c.port, store: s.port, now: () => new Date(NOW) }, request());
    let fail = true;
    const flaky: GuestClusterPort = { ...c.port, deleteGuestObjects: async () => { if (fail) throw new GuestCredentialError("minter_rejected"); } };
    expect(await revokeGuestBindings({ cluster: flaky, store: s.port }, { workspaceId: WS, connectionId: CONN })).toEqual({ revoked: 0, pending: 1 });
    expect(s.rows.get("app/read")).toMatchObject({ status: "revoking", error: "minter_rejected" });
    expect((await refusal(mintGuestCredential({ cluster: c.port, store: s.port }, request()))).code).toBe("binding_revoked");
    fail = false;
    expect(await revokeGuestBindings({ cluster: flaky, store: s.port }, { workspaceId: WS, connectionId: CONN })).toEqual({ revoked: 1, pending: 0 });
  });
});
