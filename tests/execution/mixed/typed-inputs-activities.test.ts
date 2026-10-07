/**
 * The producer and consumer activities with a typed-input port (PROD-MIX follow-up, round 2), over the isolated execution
 * fakes (a scripted OpenTofu port and a fake credential broker: NOT real tofu, NOT a cloud; the real OpenTofu proof is
 * tests/tofu/typed-inputs.test.ts).
 *
 * Producer: the apply activity captures `tofu output -json` through the port while its grant is live, asks the engine for
 * sensitive values only when a consumer declared a secret reference, never lets a value reach evidence, events, logs or
 * the activity result, and does not turn a capture failure into a failed apply.
 *
 * Consumer: the typed inputs reach the rendered configuration as declared variables (non-secret default only), a secret
 * reaches the tool only through the dedicated input channel, and the consumer's approval is invalidated through DUR-B when a
 * consumed output digest moves.
 */
import { afterEach, describe, expect, it } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { StepFailedError } from "@/lib/execution/errors";
import { SemanticsChangedError } from "@/lib/execution/semantics/errors";
import type { CapturedOutputs, ConsumedInput, ProducerContract, TypedInputsPort } from "@/lib/execution/typed-inputs";
import { OP, bucketManifest } from "../fakes/fixtures";
import { createWorld, type World } from "../fakes/world";

const h = (c: string): string => c.repeat(64);
const MATERIAL = ["s3cr3t", "material", String(Date.now())].join("-");
const ENDPOINT = "db.internal.example";
const HOST: ConsumedInput = { name: "endpoint_db", referenceId: "db-host", type: "endpoint", valueDigest: digest({ type: "endpoint", value: ENDPOINT }), value: ENDPOINT };
const SECRET: ConsumedInput = { name: "db_password", referenceId: "db-secret", type: "secret_ref", valueDigest: h("a"), secret: { ref: "vault:proj/mixabc/outdef", versionDigest: h("b") } };
const HOST_CONTRACT: ProducerContract = { referenceId: "db-host", producerAddress: "resource/db", producerOutput: "endpoint", type: "endpoint" };
const SECRET_CONTRACT: ProducerContract = { referenceId: "db-secret", producerAddress: "resource/db", producerOutput: "password", type: "secret_ref" };

class FakePort implements TypedInputsPort {
  contract: ProducerContract[] = [];
  inputs: ConsumedInput[] = [];
  secrets = new Map<string, string>();
  captured: CapturedOutputs[] = [];
  failCapture = false;
  resolved: string[] = [];
  async producerContract() { return this.contract; }
  async capture(input: CapturedOutputs) {
    if (this.failCapture) throw new Error("vault unavailable");
    this.captured.push(input);
    return { recorded: this.contract.length };
  }
  async load() { return this.inputs; }
  async resolveSecret(_workspaceId: string, _operationId: string, ref: string) {
    this.resolved.push(ref);
    const value = this.secrets.get(ref);
    if (value === undefined) throw new StepFailedError("That secret is not an input of this operation.");
    return value;
  }
}

const worlds: World[] = [];
function world(port: FakePort): World {
  const w = createWorld();
  w.product.setManifest(bucketManifest());
  w.broker.approval = { approved: true, rejected: false, approvalId: "isolated-reviewed-human-fixture" };
  w.deps.typedInputs = port;
  worlds.push(w);
  return w;
}
afterEach(() => { while (worlds.length) worlds.pop()!.dispose(); });

async function planned(w: World) {
  await w.activities.markOperation({ operationId: OP, status: "running" });
  await w.activities.validateDesiredState({ operationId: OP });
  const lease = await w.lease();
  const plan = await w.activities.planInfrastructure({ operationId: OP, lease });
  return { lease, plan };
}
const mainOf = (w: World, call = 0) => JSON.parse(w.tofu.planCalls[call].ws.files.find((f) => f.path === "main.tf.json")!.content) as { variable?: Record<string, unknown> };
const everywhere = (w: World, ...extra: unknown[]): string => JSON.stringify([w.stored(), w.logs, w.heartbeats, ...extra]);

describe("the producer's apply captures its outputs while its grant is live", () => {
  it("passes outputs and (only for a secret reference) sensitive values to the port, and keeps every value out of evidence, events, logs and the result", async () => {
    const port = new FakePort();
    port.contract = [HOST_CONTRACT, SECRET_CONTRACT];
    const w = world(port);
    w.tofu.outputs = { alb_dns_name: { sensitive: false, type: "string", value: ENDPOINT }, db_master_password: { sensitive: true, type: "string" } };
    w.tofu.sensitiveOutputs = { db_master_password: MATERIAL };
    const { lease, plan } = await planned(w);
    const result = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });

    expect(w.tofu.applyCalls[0].captureSensitive).toBe(true);
    expect(port.captured).toHaveLength(1);
    expect(port.captured[0]).toMatchObject({ operationId: OP, planDigest: plan.planDigest, sensitive: { db_master_password: MATERIAL } });
    expect(port.captured[0].outputs.alb_dns_name).toMatchObject({ sensitive: false, value: ENDPOINT });
    expect(port.captured[0].outputs.db_master_password).toEqual({ sensitive: true, type: "string" });
    expect(everywhere(w, result)).not.toContain(MATERIAL);
    // the evidence names outputs and sensitivity only, as before
    expect(JSON.stringify(w.evidence.ofKind("tofu_apply")[0].summary)).not.toContain(ENDPOINT);
  });

  it("does not ask the engine for sensitive values when no consumer declared a secret reference", async () => {
    const port = new FakePort();
    port.contract = [HOST_CONTRACT];
    const w = world(port);
    w.tofu.sensitiveOutputs = { db_master_password: MATERIAL };
    const { lease, plan } = await planned(w);
    await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    expect(w.tofu.applyCalls[0].captureSensitive).toBe(false);
    expect(port.captured[0].sensitive).toBeUndefined();
  });

  it("captures nothing for an operation nobody consumes", async () => {
    const port = new FakePort();
    const w = world(port);
    const { lease, plan } = await planned(w);
    await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    expect(port.captured).toEqual([]);
    expect(w.tofu.applyCalls[0].captureSensitive).toBe(false);
  });

  it("does not turn a capture failure into a failed apply: the apply happened, the consumer will be refused instead", async () => {
    const port = new FakePort();
    port.contract = [HOST_CONTRACT, SECRET_CONTRACT];
    port.failCapture = true;
    const w = world(port);
    w.tofu.sensitiveOutputs = { db_master_password: MATERIAL };
    const { lease, plan } = await planned(w);
    const result = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    expect(result.applied).toBe(1);
    expect(w.logs.some((entry) => entry.level === "warn" && /capture the producer outputs/.test(entry.message))).toBe(true);
    expect(everywhere(w, result)).not.toContain(MATERIAL);
  });
});

describe("the consumer receives its typed inputs", () => {
  it("declares them in the rendered configuration, offers the secret only on the input channel, and leaks it nowhere", async () => {
    const port = new FakePort();
    port.inputs = [HOST, SECRET];
    port.secrets.set(SECRET.secret!.ref, MATERIAL);
    const w = world(port);
    const { lease, plan } = await planned(w);

    const variables = mainOf(w).variable as Record<string, unknown>;
    expect(variables.zenith_in_endpoint_db).toEqual({ type: "string", default: ENDPOINT });
    expect(variables.zenith_in_db_password).toEqual({ type: "string", sensitive: true });
    expect(w.tofu.planCalls[0].inputEnvKeys).toEqual(["TF_VAR_zenith_in_db_password"]);
    expect(w.tofu.lastInputEnv.TF_VAR_zenith_in_db_password).toBe(MATERIAL);
    expect(port.resolved).toContain(SECRET.secret!.ref);
    expect(w.tofu.planCalls[0].ws.files.map((f) => f.content).join("\n")).not.toContain(MATERIAL);

    await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    expect(w.tofu.applyCalls[0].inputEnvKeys).toEqual(["TF_VAR_zenith_in_db_password"]);
    expect(everywhere(w, plan)).not.toContain(MATERIAL);
  });

  it("leaves an operation that consumes nothing untouched: no variables, no input channel", async () => {
    const port = new FakePort();
    const w = world(port);
    await planned(w);
    expect(mainOf(w).variable).toBeUndefined();
    expect(w.tofu.planCalls[0].inputEnvKeys).toEqual([]);
  });

  it("refuses to run when it consumes a secret that custody cannot resolve", async () => {
    const port = new FakePort();
    port.inputs = [SECRET];
    const w = world(port);
    await w.activities.markOperation({ operationId: OP, status: "running" });
    await w.activities.validateDesiredState({ operationId: OP });
    const lease = await w.lease();
    await expect(w.activities.planInfrastructure({ operationId: OP, lease })).rejects.toBeInstanceOf(StepFailedError);
    expect(w.tofu.planCalls).toHaveLength(0);
  });
});

describe("a changed producer output invalidates the consumer's approval (DUR-B)", () => {
  it("refuses the apply when a secret input's version moved after the plan was reviewed, naming the configuration component", async () => {
    const port = new FakePort();
    port.inputs = [HOST, SECRET];
    port.secrets.set(SECRET.secret!.ref, MATERIAL);
    const w = world(port);
    const { lease, plan } = await planned(w);
    port.inputs = [HOST, { ...SECRET, secret: { ref: SECRET.secret!.ref, versionDigest: h("c") } }];
    let failure: unknown;
    try { await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SemanticsChangedError);
    expect((failure as SemanticsChangedError).changed).toEqual(["configuration"]);
    expect(everywhere(w, String(failure))).not.toContain(MATERIAL);
  });

  it("refuses the apply when a non-secret input value changed after the plan was reviewed", async () => {
    const port = new FakePort();
    port.inputs = [HOST];
    const w = world(port);
    const { lease, plan } = await planned(w);
    port.inputs = [{ ...HOST, value: "db.other.example", valueDigest: digest({ type: "endpoint", value: "db.other.example" }) }];
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease })).rejects.toBeInstanceOf(StepFailedError);
  });

  it("still applies when nothing moved", async () => {
    const port = new FakePort();
    port.inputs = [HOST, SECRET];
    port.secrets.set(SECRET.secret!.ref, MATERIAL);
    const w = world(port);
    const { lease, plan } = await planned(w);
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease })).resolves.toMatchObject({ applied: 1 });
  });
});
