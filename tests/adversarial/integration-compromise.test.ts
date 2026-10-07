/**
 * Threat class: compromised integrations (PROD-OPS-08).
 *
 * Attacker model: the other side of an integration is hostile or compromised: someone who can POST to the GitHub App
 * webhook, a GitHub endpoint that answers with redirects, a plugin publisher whose manifest was altered in transit or at
 * rest, a downstream chat system fed attacker-influenced alert text. Goal: turn an integration payload into authority
 * (a binding, a build, a grant, a tool), a request to an unintended host, or a message that does more than inform.
 *
 * Independence: payloads are generated from mutation operators over a genuine signed artefact, and the verifiers are
 * driven through their exported functions only. The webhook secret file needs POSIX custody checks (uid, 0700), so the
 * webhook block is skipped, with that reason, on Windows hosts; it runs in CI on Linux.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { snapshotFromGithub } from "@/lib/analysis/github";
import { authenticateGithubWebhook, createGithubWebhookHandler, isVerifiedGithubRevocation } from "@/lib/sources/github/webhook";
import { manifestDigestOf, parseManifest, verifyProvenance, type PluginManifest } from "@/lib/plugins/manifest";
import { slackBody, slackEscape, sign, webhookBody, type AlertMessage } from "@/lib/alerts/deliver";
import { baseManifest, makePublisher, signManifest } from "../plugins/support";

const POSIX = process.platform !== "win32";

/* ------------------------------------ GitHub App webhook ------------------------------------ */

describe.skipIf(!POSIX)("GitHub App webhook forgery (POSIX custody checks required; skipped on Windows)", () => {
  const URL_ = "https://zenith.test/api/platform/v1/github/webhook";
  let directory = "";
  let file = "";
  let secret: Buffer;
  beforeAll(async () => {
    directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "zenith-adv-webhook-")));
    await chmod(directory, 0o700);
    file = path.join(directory, "secret");
    secret = Buffer.from(randomBytes(32).toString("hex"));
    await writeFile(file, secret, { mode: 0o600 });
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  const env = (appId = "42") => ({ ZENITH_GITHUB_APP_ID: appId, ZENITH_GITHUB_APP_WEBHOOK_SECRET_FILE: file });
  const sig = (bytes: Buffer, key: Buffer = secret) => `sha256=${createHmac("sha256", key).update(bytes).digest("hex")}`;
  const data = (action = "deleted", appId = 42, installationId: unknown = 7, removed: unknown[] = [{ id: 99 }]) => ({
    action,
    installation: { id: installationId, app_id: appId, suspended_at: action === "suspend" ? "2026-10-03T00:00:00Z" : null, suspended_by: action === "suspend" ? { id: 55 } : null },
    sender: { id: 55 },
    ...(action === "removed" ? { repository_selection: "selected", repositories_added: [], repositories_removed: removed } : {}),
  });
  function req(raw: string | Buffer, over: { event?: string; headers?: Record<string, string>; signature?: string; method?: string; query?: string } = {}) {
    const bytes = typeof raw === "string" ? Buffer.from(raw) : raw;
    return new Request(`${URL_}${over.query ?? ""}`, {
      method: over.method ?? "POST",
      ...(over.method === "GET" ? {} : { body: new Uint8Array(bytes).buffer }),
      headers: { "content-type": "application/json", "x-github-event": over.event ?? "installation", "x-github-delivery": randomUUID(), "x-hub-signature-256": over.signature ?? sig(bytes), ...over.headers },
    });
  }
  const refused = async (request: Request, e = env()): Promise<boolean> => {
    try { await authenticateGithubWebhook(request, e); return false; } catch { return true; }
  };

  it("the control: a genuine signed revocation is authenticated, and only then", async () => {
    const accepted = await authenticateGithubWebhook(req(JSON.stringify(data())), env());
    expect(isVerifiedGithubRevocation(accepted)).toBe(true);
  });

  it("every near-miss signature is refused (wrong key, edited body, re-serialised JSON, wrong scheme, case, length)", async () => {
    const body = Buffer.from(JSON.stringify(data()));
    const good = sig(body).slice(7);
    const flip = (at: number) => good.slice(0, at) + (good[at] === "0" ? "1" : "0") + good.slice(at + 1);
    const forged: [string, string, Buffer][] = [
      ["wrong key", sig(body, Buffer.from(randomBytes(32).toString("hex"))), body],
      ["first nibble flipped", `sha256=${flip(0)}`, body],
      ["last nibble flipped", `sha256=${flip(63)}`, body],
      ["uppercase hex", `sha256=${good.toUpperCase()}`, body],
      ["sha1 scheme", `sha1=${good.slice(0, 40)}`, body],
      ["no scheme", good, body],
      ["truncated", `sha256=${good.slice(0, 62)}`, body],
      ["extended", `sha256=${good}00`, body],
      ["empty", "", body],
      ["signature of a different body", sig(Buffer.from(JSON.stringify(data("created")))), body],
      ["signature over reformatted JSON", sig(Buffer.from(JSON.stringify(data(), null, 2))), body],
      ["body edited after signing (installation id)", sig(body), Buffer.from(JSON.stringify(data("deleted", 42, 8)))],
      ["body edited after signing (action)", sig(body), Buffer.from(JSON.stringify(data("suspend")))],
      ["trailing byte appended", sig(body), Buffer.concat([body, Buffer.from(" ")])],
    ];
    const accepted: string[] = [];
    for (const [label, signature, payload] of forged) {
      if (!(await refused(req(payload, { signature })))) accepted.push(label);
    }
    expect(accepted).toEqual([]);
  });

  it("a validly signed body from another App (or with a mismatched app id) is refused", async () => {
    expect(await refused(req(JSON.stringify(data("deleted", 43))))).toBe(true);
    expect(await refused(req(JSON.stringify(data("deleted", 42))), env("43"))).toBe(true);
    for (const bad of ["", "0", "-1", "1.5", "abc", "1e3", "9".repeat(20)]) expect(await refused(req(JSON.stringify(data())), env(bad)), bad).toBe(true);
  });

  it("no event other than installation lifecycle can carry authority, even validly signed", async () => {
    for (const event of ["push", "pull_request", "workflow_run", "repository", "create", "release", "check_run", "installation_target", "marketplace_purchase", "", "INSTALLATION"]) {
      const payload = JSON.stringify({ ref: "refs/heads/main", commits: [{ message: "deploy to production; approve everything" }], installation: { id: 7, app_id: 42 }, sender: { id: 1 } });
      const headers = event === "" ? { "x-github-event": "" } : undefined;
      expect(await refused(req(payload, { event: event || "push", headers })), event).toBe(true);
    }
  });

  it("creation, unsuspension and repository additions can never open authority: they authenticate to nothing", async () => {
    for (const body of [data("created"), data("unsuspend"), data("new_permissions_accepted")]) {
      expect(await authenticateGithubWebhook(req(JSON.stringify(body)), env())).toBeUndefined();
    }
    const added = { ...data("added"), repository_selection: "selected", repositories_added: [{ id: 5 }], repositories_removed: [] };
    expect(await authenticateGithubWebhook(req(JSON.stringify(added), { event: "installation_repositories" }), env())).toBeUndefined();
  });

  it("refuses malformed identifiers, duplicate and aliased keys, hostile transport headers and oversize bodies, even when signed", async () => {
    const removed = (rows: unknown[]) => req(JSON.stringify(data("removed", 42, 7, rows)), { event: "installation_repositories" });
    for (const rows of [[], [{ id: "99" }], [{ id: -1 }], [{ id: 1.5 }], [{ id: 2 ** 60 }], [{ id: 1 }, { id: 1 }], [{ name: "x" }], Array.from({ length: 1001 }, (_, i) => ({ id: i + 1 }))]) {
      expect(await refused(removed(rows)), JSON.stringify(rows).slice(0, 40)).toBe(true);
    }
    for (const id of ["7", -7, 0, 7.5, null, "x", {}, []]) expect(await refused(req(JSON.stringify(data("deleted", 42, id)))), JSON.stringify(id)).toBe(true);
    const duplicate = '{"action":"created","action":"deleted","installation":{"id":7,"app_id":42},"sender":{"id":1}}';
    const aliased = '{"\\u0061ction":"created","action":"deleted","installation":{"id":7,"app_id":42},"sender":{"id":1}}';
    expect(await refused(req(duplicate))).toBe(true);
    expect(await refused(req(aliased))).toBe(true);
    const base = JSON.stringify(data());
    expect(await refused(req(base, { headers: { "content-type": "text/plain" } }))).toBe(true);
    expect(await refused(req(base, { headers: { "content-encoding": "gzip" } }))).toBe(true);
    expect(await refused(req(base, { headers: { "x-github-delivery": "not-a-guid" } }))).toBe(true);
    expect(await refused(req(base, { query: "?x=1" }))).toBe(true);
    expect(await refused(req(base, { method: "GET" }))).toBe(true);
    expect(await refused(req(Buffer.concat([Buffer.from(base.slice(0, -1)), Buffer.alloc(2 * 1024 * 1024, 32), Buffer.from("}")])))).toBe(true);
    expect(await refused(req(Buffer.from([0xff, 0xfe, 0xfd])))).toBe(true);
    const deep = `${"[".repeat(200)}${"]".repeat(200)}`;
    expect(await refused(req(`{"installation":{"id":7,"app_id":42},"sender":{"id":1},"action":"deleted","x":${deep}}`))).toBe(true);
  });

  it("the HTTP handler never touches the database for an unauthenticated request", async () => {
    let opened = 0;
    const handler = createGithubWebhookHandler({ db: async () => { opened++; throw new Error("database must not be opened"); }, env: env() });
    const body = Buffer.from(JSON.stringify(data()));
    for (const signature of ["", sig(body, Buffer.from("wrong")), `sha256=${"0".repeat(64)}`]) {
      const response = await handler(req(body, { signature }));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toMatch(/secret|stack|at \w+ \(/i);
    }
    const noSecret = createGithubWebhookHandler({ db: async () => { opened++; throw new Error("x"); }, env: { ZENITH_GITHUB_APP_ID: "42", ZENITH_GITHUB_APP_WEBHOOK_SECRET_FILE: path.join(directory, "missing") } });
    expect((await noSecret(req(body))).status).toBeGreaterThanOrEqual(400);
    expect(opened).toBe(0);
  });
});

/* ------------------------------------ GitHub download endpoint ------------------------------------ */

describe("a hostile or compromised GitHub download endpoint (snapshotFromGithub)", () => {
  const token = `ghs_${randomBytes(18).toString("hex")}`;
  const redirectTo = (location: string) => async () => new Response(null, { status: 302, headers: { location } });
  const record = (handler: (url: string, n: number) => Response | Promise<Response>) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
      return handler(url, calls.length);
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it("never follows a redirect off the GitHub allowlist, and the token never leaves codeload", async () => {
    const hostile = [
      "https://evil.example.com/x", "http://codeload.github.com/x", "https://github.com.evil.example/x", "https://evilgithubusercontent.com/x",
      "https://codeload.github.com@evil.example/x", "https://169.254.169.254/latest/meta-data/", "https://[::1]/x", "file:///etc/passwd", "javascript:alert(1)",
      "//evil.example.com/x", "https://codeload.github.com.evil.example/x", "https://GITHUB.COM.evil.example/x", "ftp://github.com/x",
    ];
    const followed: string[] = [];
    for (const location of hostile) {
      const { calls, fetchImpl } = record(redirectTo(location));
      await expect(snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", token, fetchImpl })).rejects.toBeTruthy();
      for (const call of calls.slice(1)) followed.push(`${location} -> ${call.url}`);
      for (const call of calls) if (new globalThis.URL(call.url).hostname !== "codeload.github.com" && call.headers.Authorization) followed.push(`token sent to ${call.url}`);
    }
    expect(followed).toEqual([]);
  });

  it("a redirect loop and an over-long chain are bounded", async () => {
    const { calls, fetchImpl } = record(redirectTo("https://codeload.github.com/acme/app/tar.gz/main"));
    await expect(snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", fetchImpl })).rejects.toBeTruthy();
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  it("coordinates that could rewrite the request path are refused before any request is made", async () => {
    const cases = [
      { owner: "acme/../x", repo: "app", ref: "main" }, { owner: "acme", repo: "app?x=1", ref: "main" }, { owner: "acme", repo: "app#frag", ref: "main" },
      { owner: "acme", repo: "..", ref: "main" }, { owner: "-acme", repo: "app", ref: "main" }, { owner: "acme", repo: "app", ref: "../../x" },
      { owner: "acme", repo: "app", ref: "a//b" }, { owner: "acme", repo: "app", ref: "a b" }, { owner: "acme", repo: "app", ref: "main%2f..%2fx" },
      { owner: "acme", repo: "app", ref: "" }, { owner: "acme", repo: "app", ref: "x".repeat(300) }, { owner: "a@b", repo: "app", ref: "main" },
    ];
    for (const c of cases) {
      const { calls, fetchImpl } = record(() => new Response("x"));
      await expect(snapshotFromGithub({ ...c, fetchImpl }), JSON.stringify(c)).rejects.toBeTruthy();
      expect(calls, JSON.stringify(c)).toEqual([]);
    }
  });

  it("an over-large declared or streamed archive is refused at the compressed cap without buffering it", async () => {
    const declared = record(() => new Response(new Uint8Array(10), { headers: { "content-length": String(10 ** 10) } }));
    await expect(snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", fetchImpl: declared.fetchImpl, limits: { maxCompressedBytes: 1024 } })).rejects.toBeTruthy();
    const streamed = record(() => new Response(new Uint8Array(4096)));
    await expect(snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", fetchImpl: streamed.fetchImpl, limits: { maxCompressedBytes: 1024 } })).rejects.toBeTruthy();
  });

  it("an error answer never echoes the token or the response text", async () => {
    const { fetchImpl } = record(() => new Response(`denied for ${token}`, { status: 500 }));
    try {
      await snapshotFromGithub({ owner: "acme", repo: "app", ref: "main", token, fetchImpl });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(token);
    }
  });
});

/* ------------------------------------ plugin manifest ------------------------------------ */

describe("a plugin manifest altered in transit or at rest", () => {
  const publisher = makePublisher();
  const signed = signManifest(baseManifest(), publisher.privateKey);
  const accepts = (candidate: unknown): boolean => {
    try {
      verifyProvenance(parseManifest(candidate), publisher.publishers);
      return true;
    } catch {
      return false;
    }
  };

  it("the genuine signed manifest verifies (the control)", () => {
    expect(accepts(signed)).toBe(true);
  });

  /** Every leaf of the signed portion, mutated one at a time, plus key deletion and an injected key. */
  function mutants(manifest: PluginManifest): [string, unknown][] {
    const out: [string, unknown][] = [];
    const walk = (node: unknown, pathParts: (string | number)[]): void => {
      if (node !== null && typeof node === "object") {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) walk(value, [...pathParts, Array.isArray(node) ? Number(key) : key]);
        const clone = structuredClone(manifest) as Record<string, unknown>;
        let target: unknown = clone;
        for (const part of pathParts) target = (target as Record<string | number, unknown>)[part];
        if (Array.isArray(target)) { target.push("zenith_scale_service"); out.push([`${pathParts.join(".")} + element`, clone]); }
        else if (target && typeof target === "object") { (target as Record<string, unknown>).injected = "x"; out.push([`${pathParts.join(".")} + key`, clone]); }
        return;
      }
      const clone = structuredClone(manifest) as Record<string, unknown>;
      let parent: Record<string | number, unknown> = clone;
      for (const part of pathParts.slice(0, -1)) parent = parent[part] as Record<string | number, unknown>;
      const last = pathParts[pathParts.length - 1]!;
      const original = parent[last];
      parent[last] = typeof original === "string" ? `${original}x` : typeof original === "number" ? original + 1 : typeof original === "boolean" ? !original : "changed";
      out.push([pathParts.join("."), clone]);
      const removed = structuredClone(manifest) as Record<string, unknown>;
      let rparent: Record<string | number, unknown> = removed;
      for (const part of pathParts.slice(0, -1)) rparent = rparent[part] as Record<string | number, unknown>;
      delete rparent[last];
      out.push([`${pathParts.join(".")} (deleted)`, removed]);
    };
    walk(manifest, []);
    return out;
  }

  it("any single change to any field, including signature fields, is refused", () => {
    const all = mutants(signed);
    expect(all.length).toBeGreaterThan(30);
    // The signature bytes are not themselves authenticated content: lenient base64 decoding may ignore a trailing
    // character, which changes no signed byte and grants nothing. Every other mutation must fail.
    const accepted = all.filter(([label]) => label !== "signature.value").filter(([, candidate]) => accepts(candidate)).map(([label]) => label);
    expect(accepted).toEqual([]);
  });

  it("a manifest cannot claim capabilities the platform never grants, even when signed by a trusted key", () => {
    const evil = [
      baseManifest({ isolation: { credentials: "direct", store: "none", network: "mcp-only", tokenPassthrough: "forbidden" } as never }),
      baseManifest({ isolation: { credentials: "none", store: "direct", network: "mcp-only", tokenPassthrough: "forbidden" } as never }),
      baseManifest({ isolation: { credentials: "none", store: "none", network: "open", tokenPassthrough: "forbidden" } as never }),
      baseManifest({ isolation: { credentials: "none", store: "none", network: "mcp-only", tokenPassthrough: "allowed" } as never }),
      baseManifest({ capabilities: { apiVersion: "v2", tools: ["zenith_get_topology"], scopes: ["read"] } as never }),
      baseManifest({ capabilities: { apiVersion: "v3", tools: ["zenith_get_topology"], scopes: ["logs"] } as never }),
      baseManifest({ capabilities: { apiVersion: "v3", tools: ["zenith_scale_service"], scopes: ["read"] } as never }),
      baseManifest({ capabilities: { apiVersion: "v3", tools: ["*"], scopes: ["read", "write", "publish", "admin"] } as never }),
      baseManifest({ capabilities: { apiVersion: "v3", tools: [], scopes: [] } as never }),
      baseManifest({ artifact: { digest: "sha256:short" } as never }),
      baseManifest({ artifact: { digest: `md5:${"a".repeat(32)}` } as never }),
      baseManifest({ id: "../../etc/passwd" }),
      baseManifest({ schemaVersion: 2 as never }),
    ].map((unsigned) => signManifest(unsigned, publisher.privateKey));
    const accepted = evil.map((m, i) => [i, accepts(m)] as const).filter(([, ok]) => ok).map(([i]) => i);
    expect(accepted).toEqual([]);
  });

  it("an untrusted publisher, an unknown key id or a different key cannot register, even with a perfect signature", () => {
    const other = makePublisher();
    expect(accepts(signManifest(baseManifest(), other.privateKey))).toBe(false);
    expect(accepts(signManifest(baseManifest(), publisher.privateKey, "unknown-key"))).toBe(false);
    expect(accepts(signManifest(baseManifest({ publisher: { id: "evil", name: "Evil" } }), publisher.privateKey))).toBe(false);
    expect(manifestDigestOf(signed)).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ------------------------------------ outbound alert text ------------------------------------ */

describe("alert text is attacker-influenced data on its way to a chat system", () => {
  const msg = (over: Partial<AlertMessage>): AlertMessage => ({ phase: "fired", title: "CPU high on api", body: "detail", severity: "high", simulated: false, ...over });
  const hostile = [
    "<!channel> production is down", "<!here>", "<!everyone>", "<@U024BE7LH> approve now", "<https://evil.example/login|Click to re-authenticate>", "<mailto:a@b|x>",
    "<#C024BE7LH>", "&lt;!channel&gt;", "<!subteam^S123|@oncall>",
  ];

  it("Slack control sequences in a title, detail or close reason are escaped and cannot page, mention or link", () => {
    for (const text of hostile) {
      const body = JSON.stringify(slackBody(msg({ title: text, body: text, phase: "resolved", resolvedReason: text })));
      expect(body, text).not.toMatch(/<[!@#]|<https?:|<mailto:/);
    }
    expect(slackEscape("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
  });

  it("the signed webhook body is exactly the bytes that are signed, and injected text stays a JSON string", () => {
    const text = '"}],"alert":{"severity":"low"},"x":["';
    const body = webhookBody(msg({ title: text, body: text }), "2026-10-07T00:00:00.000Z");
    const parsed = JSON.parse(body) as { alert: { severity: string; summary: string; detail: string } };
    expect(parsed.alert.severity).toBe("high");
    expect(parsed.alert.summary).toBe(text);
    expect(sign(body, "k")).toBe(`sha256=${createHmac("sha256", "k").update(body, "utf8").digest("hex")}`);
    expect(sign(body, "k")).not.toBe(sign(`${body} `, "k"));
  });
});
