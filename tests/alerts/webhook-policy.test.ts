/**
 * What an alert webhook may reach, asserted rather than assumed.
 *
 * Two kinds of test live here, and the split matters:
 *
 *  - **the address table**, which pins one category per literal. The IPv6
 *    transition ranges (NAT64, 6to4, IPv4-compatible, Teredo) were missed
 *    precisely because nothing enumerated them, and the obfuscated IPv4 forms
 *    were safe only as a side effect of WHATWG URL normalisation that no test
 *    named. Both are named here now.
 *  - **the policy**, which is the thing an upgrade can quietly break: the
 *    acknowledgement that lets a developer POST to `http://127.0.0.1:9000` must
 *    be inert on every deployment that is not plainly a development one.
 *
 * Nothing here touches the network: every case is either an IP literal (no
 * resolution at all) or uses an injected resolver.
 */
import { afterEach, describe, expect, it } from "vitest";

const {
  DEFAULT_WEBHOOK_PORTS,
  WEBHOOK_ALLOW_INSECURE_ENV,
  WEBHOOK_ALLOWED_PORTS_ENV,
  addressCategoryForTest: category,
  isTransientPolicyFailure,
  resolveWebhookTarget,
  validateWebhookTarget,
  webhookEgressPolicy,
  webhookTargetInputProblem,
  WebhookPolicyError,
} = await import("@/lib/alerts/webhook-policy");

const ENV_KEYS = [
  WEBHOOK_ALLOW_INSECURE_ENV,
  WEBHOOK_ALLOWED_PORTS_ENV,
  "ZENITH_HOSTED_MODE",
  "ZENITH_STORE",
  "ZENITH_SERVERLESS",
  "VERCEL",
] as const;

const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A resolver that answers with exactly these addresses and nothing else. */
const answers = (...addresses: string[]) => async () => addresses;

/* ------------------------------- the address table ------------------------- */

describe("which addresses are restricted", () => {
  it.each([
    // The IPv6 transition ranges. Each of these decodes to an address that is
    // already blocked directly, and each one reached it before.
    ["64:ff9b::7f00:1", "nat64 (loopback)"],
    ["64:ff9b::a9fe:a9fe", "nat64 (metadata)"],
    ["64:ff9b:1::a9fe:a9fe", "nat64 (metadata)"],
    ["2002:7f00:1::", "6to4 (loopback)"],
    ["2002:a9fe:a9fe::1", "6to4 (metadata)"],
    ["::7f00:1", "ipv4-compatible (loopback)"],
    ["::a9fe:a9fe", "ipv4-compatible (metadata)"],
    ["2001::1", "teredo"],
    ["192.88.99.1", "6to4-relay"],
    // IPv4-mapped IPv6, which was already handled but never asserted.
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:169.254.169.254", "metadata"],
    ["::ffff:7f00:1", "loopback"],
    // The metadata services, which no policy ever unblocks.
    ["169.254.169.254", "metadata"],
    ["100.100.100.200", "metadata"],
    ["fd00:ec2::254", "metadata"],
    // The ordinary private space.
    ["127.0.0.1", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["192.168.1.20", "private"],
    ["169.254.10.10", "link-local"],
    ["100.64.0.1", "reserved"],
    ["0.0.0.0", "reserved"],
    ["198.18.0.1", "reserved"],
    ["224.0.0.1", "multicast/reserved"],
    ["203.0.113.5", "documentation"],
    // IPv6 unicast-local, link-local and multicast.
    ["::1", "loopback"],
    ["::", "reserved"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
  ])("categorises %s as %s", (address, expected) => {
    expect(category(address)).toBe(expected);
  });

  it.each(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "8.8.8.8"])(
    "leaves the public address %s alone",
    (address) => {
      expect(category(address)).toBeUndefined();
    }
  );

  it("refuses a transition address end to end, not only in the table", async () => {
    for (const target of [
      "https://[64:ff9b::a9fe:a9fe]/latest/meta-data/",
      "https://[2002:a9fe:a9fe::1]/hooks",
      "https://[::a9fe:a9fe]/hooks",
      "https://192.88.99.1/hooks",
      "https://[2001::1]/hooks",
    ])
      await expect(validateWebhookTarget(target)).rejects.toThrow(/restricted network destination/i);
  });

  it("refuses a hostname whose AAAA answer is a NAT64 address", async () => {
    // The DNS64 case: the name is innocuous and the synthesised answer is not.
    await expect(
      validateWebhookTarget("https://alerts.example.test/hooks", {
        resolveAll: answers("64:ff9b::a9fe:a9fe"),
      })
    ).rejects.toThrow(/restricted network destination/i);
  });
});

/* ---------------------------- obfuscated literals -------------------------- */

describe("obfuscated IPv4 literals", () => {
  // These are normalised to dotted-quad by the WHATWG URL parser before the
  // policy sees them. That is a side effect of the platform, not a decision
  // this code makes, so it is pinned here: a change of parser must break a
  // test rather than open a bypass.
  it.each([
    ["https://0x7f000001/hooks", "127.0.0.1"],
    ["https://2130706433/hooks", "127.0.0.1"],
    ["https://127.1/hooks", "127.0.0.1"],
    ["https://0177.0.0.1/hooks", "127.0.0.1"],
    ["https://017700000001/hooks", "127.0.0.1"],
    ["https://0/hooks", "0.0.0.0"],
    ["https://0xa9fea9fe/hooks", "169.254.169.254"],
  ])("normalises %s to %s and refuses it", async (target, hostname) => {
    expect(new URL(target).hostname).toBe(hostname);
    await expect(validateWebhookTarget(target)).rejects.toThrow(/restricted network destination/i);
  });
});

/* --------------------------------- URL shape ------------------------------- */

describe("the URL itself", () => {
  it("refuses embedded credentials, a fragment and a local hostname", () => {
    expect(webhookTargetInputProblem("https://user:pass@alerts.example.test/hooks")).toMatch(
      /username or password/i
    );
    expect(webhookTargetInputProblem("https://alerts.example.test/hooks#frag")).toMatch(/fragment/i);
    expect(webhookTargetInputProblem("https://localhost/hooks")).toMatch(/local hostname/i);
    expect(webhookTargetInputProblem("https://a.localhost./hooks")).toMatch(/local hostname/i);
    expect(webhookTargetInputProblem("https://alerts.example.test/hooks")).toBeUndefined();
  });

  it("names the action in every refusal and never the address behind it", async () => {
    const problem = webhookTargetInputProblem("https://10.0.0.8/hooks")!;
    expect(problem).toMatch(/Settings → Alerts/);
    expect(problem).not.toContain("10.0.0.8");
    const dns = await resolveWebhookTarget("https://alerts.example.test/hooks", {
      resolveAll: answers("93.184.216.34", "192.168.1.20"),
    }).catch((err: unknown) => err);
    expect((dns as Error).message).not.toContain("192.168");
  });
});

/* ---------------------------------- ports ---------------------------------- */

describe("the port policy", () => {
  it("allows 443 and 8443 and refuses everything else", async () => {
    expect(DEFAULT_WEBHOOK_PORTS).toEqual([443, 8443]);
    expect(webhookTargetInputProblem("https://alerts.example.test/hooks")).toBeUndefined();
    expect(webhookTargetInputProblem("https://alerts.example.test:443/hooks")).toBeUndefined();
    expect(webhookTargetInputProblem("https://alerts.example.test:8443/hooks")).toBeUndefined();
    const refused = webhookTargetInputProblem("https://alerts.example.test:9200/hooks")!;
    expect(refused).toMatch(/port 443, 8443/);
    expect(refused).toMatch(/9200/);
    expect(refused).toMatch(new RegExp(WEBHOOK_ALLOWED_PORTS_ENV));
  });

  it("takes an operator allowlist in addition to the defaults", () => {
    process.env[WEBHOOK_ALLOWED_PORTS_ENV] = "9200, 10443";
    expect(webhookEgressPolicy().allowedPorts).toEqual([443, 8443, 9200, 10443]);
    expect(webhookTargetInputProblem("https://alerts.example.test:9200/hooks")).toBeUndefined();
    expect(webhookTargetInputProblem("https://alerts.example.test:9201/hooks")).toMatch(/port/);
  });

  it("ignores a malformed entry rather than taking every channel offline", () => {
    process.env[WEBHOOK_ALLOWED_PORTS_ENV] = "not-a-port,,70000,0,9200";
    expect(webhookEgressPolicy().allowedPorts).toEqual([443, 8443, 9200]);
  });
});

/* -------------------------------- the policy ------------------------------- */

describe("the development acknowledgement", () => {
  it("is off by default: the strict policy is what an unset environment gets", () => {
    const policy = webhookEgressPolicy();
    expect(policy.mode).toBe("strict");
    expect(policy.allowInsecureTransport).toBe(false);
    expect(policy.allowPrivateAddresses).toBe(false);
    expect(policy.acknowledgementRefused).toBeUndefined();
    expect(webhookTargetInputProblem("http://alerts.example.test/hooks")).toMatch(/must use https/i);
  });

  it("lets a development machine reach a plaintext local receiver when set", async () => {
    process.env[WEBHOOK_ALLOW_INSECURE_ENV] = "1";
    delete process.env.ZENITH_HOSTED_MODE;
    delete process.env.ZENITH_SERVERLESS;
    delete process.env.VERCEL;
    process.env.ZENITH_STORE = "file";

    expect(webhookEgressPolicy().mode).toBe("local-development");
    expect(webhookTargetInputProblem("http://127.0.0.1:9000/hooks")).toBeUndefined();
    expect(webhookTargetInputProblem("http://localhost:3001/hooks")).toBeUndefined();
    expect(webhookTargetInputProblem("https://192.168.1.20/hooks")).toBeUndefined();
    // `localhost` is a hosts-file name; it is answered directly rather than
    // through a resolver that would not know it.
    expect((await resolveWebhookTarget("http://localhost:3001/hooks")).address).toBe("127.0.0.1");
  });

  it("never opens the metadata services or a transition range, even when honoured", async () => {
    process.env[WEBHOOK_ALLOW_INSECURE_ENV] = "1";
    process.env.ZENITH_STORE = "file";
    delete process.env.ZENITH_HOSTED_MODE;
    delete process.env.ZENITH_SERVERLESS;
    delete process.env.VERCEL;

    expect(webhookEgressPolicy().mode).toBe("local-development");
    for (const target of [
      "http://169.254.169.254/latest/meta-data/",
      "http://100.100.100.200/",
      "http://[fd00:ec2::254]/",
      "http://[64:ff9b::7f00:1]/",
      "http://192.88.99.1/",
    ])
      await expect(validateWebhookTarget(target)).rejects.toThrow(/restricted network destination/i);
  });

  it.each([
    ["hosted mode", { ZENITH_HOSTED_MODE: "1" }, /hosted mode is on/],
    ["a Postgres product store", { ZENITH_STORE: "postgres" }, /PostgreSQL/],
    ["a serverless instance", { ZENITH_SERVERLESS: "1" }, /serverless/],
    ["a Vercel instance", { VERCEL: "1" }, /serverless/],
  ])("is ignored on %s, and says so", async (_name, vars, why) => {
    process.env[WEBHOOK_ALLOW_INSECURE_ENV] = "1";
    delete process.env.ZENITH_HOSTED_MODE;
    delete process.env.ZENITH_SERVERLESS;
    delete process.env.VERCEL;
    process.env.ZENITH_STORE = "file";
    Object.assign(process.env, vars);

    const policy = webhookEgressPolicy();
    expect(policy.mode).toBe("strict");
    expect(policy.allowInsecureTransport).toBe(false);
    expect(policy.allowPrivateAddresses).toBe(false);
    expect(policy.acknowledgementRefused).toMatch(why);

    // And the refusal itself tells the operator the variable did nothing.
    const problem = webhookTargetInputProblem("http://10.0.0.8:9000/hooks")!;
    expect(problem).toMatch(/must use https/i);
    expect(problem).toMatch(new RegExp(`${WEBHOOK_ALLOW_INSECURE_ENV} is set but ignored`));
    await expect(validateWebhookTarget("https://10.0.0.8/hooks")).rejects.toThrow(
      /restricted network destination/i
    );
  });
});

/* ------------------------------ retry semantics ---------------------------- */

describe("which failures are worth retrying", () => {
  it("calls a resolver failure transient and a policy refusal permanent", async () => {
    expect(isTransientPolicyFailure("dns")).toBe(true);
    expect(isTransientPolicyFailure("timeout")).toBe(true);
    expect(isTransientPolicyFailure("blocked")).toBe(false);
    expect(isTransientPolicyFailure("invalid")).toBe(false);

    const dns = await validateWebhookTarget("https://alerts.example.test/hooks", {
      resolveAll: async () => {
        throw new Error("ENOTFOUND");
      },
    }).catch((err: unknown) => err);
    expect(dns).toBeInstanceOf(WebhookPolicyError);
    expect((dns as InstanceType<typeof WebhookPolicyError>).kind).toBe("dns");

    const blocked = await validateWebhookTarget("https://10.0.0.8/hooks").catch(
      (err: unknown) => err
    );
    expect((blocked as InstanceType<typeof WebhookPolicyError>).kind).toBe("blocked");
  });
});
