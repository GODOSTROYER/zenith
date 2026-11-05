/**
 * ProductScenarioPort for OPS-08 (live sandbox): adversarial probes against real AWS-backed product state.
 *
 * Tenant A connects the sandbox roles (their trust names A's ExternalId only) and deploys one managed S3 bucket. Tenant B, an
 * admin of its own workspace, then attacks it:
 *  - cross-tenant reads: A's operation and environment deployments, by id, are refused and leak nothing of A;
 *  - cross-tenant actions: deploy.apply on A's environment, connection.verifyAws on A's connection and env.create on A's
 *    connection are refused;
 *  - confused deputy: B registers a connection naming A's own observe and deploy roles; real STS refuses B's ExternalId, so the
 *    connection never verifies, while A's still does;
 *  - forged approval: A proposes a second deploy; B's approval of it is refused and the proposal stays unapproved.
 * Independent readback: A's environment still holds exactly its one tagged bucket. These are the builder's probes; the OPS-08
 * independence (a tester's review of them) is recorded apart from this check.
 *
 * Cleanup destroys exactly the recorded state (state-destroy.ts) and restores the sandbox trust, as OPS-05 does.
 */
import type { EnvLike } from "../../config";
import type { Call, Json, ProductScenarioPort } from "../contracts";
import { laneSuffix, liveRoleNames } from "../plan";
import type { Deploy01Product, Deploy01Tenant } from "./deploy-01-driver";
import { fill, parsePolicy, refuse, Refusal, templateExternalId, trustDocument } from "./mix-03";
import { destroyFromState, readState, type SessionCredentials, type StateDestroyInput } from "./state-destroy";

type Invoke = (call: Call, values?: Record<string, string>, extra?: Record<string, Json>) => Promise<Record<string, unknown>>;
const EXTERNAL_ID_NEW = /^zenith-[0-9a-f]{32}$/;
const BUCKET = /^arn:aws:s3:::[a-z0-9.-]{3,63}$/;
const field = (value: unknown, key: string): unknown => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

export function ops08Manifest(runId: string, buckets: 1 | 2): Record<string, unknown> {
  const name = (n: number) => `ops08-${runId.slice(-8).toLowerCase()}-${n}`;
  return { version: 1, routes: [], bindings: [], services: [],
    resources: [1, 2].slice(0, buckets).map(n => ({ id: `assets-${n}`, name: name(n), kind: "object_store", config: {}, size: "small", ownership: "managed" })) };
}

export interface Ops08Seams {
  product?: Deploy01Product;
  sleep?: (ms: number) => Promise<void>;
  propagation?: { attempts: number; intervalMs: number };
  state?: { read: (input: StateDestroyInput) => Promise<unknown>; destroy: (input: StateDestroyInput) => Promise<{ destroyed: number; destroyedArns?: string[]; destroyedIds?: string[] }> };
}

export function ops08Port(env: EnvLike = process.env, seams: Ops08Seams = {}): ProductScenarioPort {
  const product = seams.product ?? refuse("the OPS-08 browser driver is not wired");
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const propagation = seams.propagation ?? { attempts: 12, intervalMs: 15_000 };
  const state = seams.state ?? { read: readState, destroy: destroyFromState };
  return {
    async verify(requirement, { plan, call }) {
      if (requirement.id !== "PROD-OPS-08") return { complete: false, reason: `${requirement.id}: not implemented by this port` };
      const invoke: Invoke = (c, values = {}, extra = {}) => call(c, { ...fill(c.input, values), ...extra });
      const planned = (id: string): Call => plan.productCalls?.find(c => c.id === id) ?? refuse(`the plan has no call ${id}`);
      const account = plan.settings.accountId, region = plan.settings.region, runId = plan.settings.runId;
      const bootstrapNameSuffix = laneSuffix(plan.settings), names = liveRoleNames(bootstrapNameSuffix);
      const stateBucket = `zenith-state-${account}-${region}${bootstrapNameSuffix}`;
      const principal = `arn:aws:iam::${account}:role/${names.principal}`;
      const roleArns = { observe: `arn:aws:iam::${account}:role/${names.observe}`, deploy: `arn:aws:iam::${account}:role/${names.deploy}` };
      const tofu = env.ZENITH_TOFU_BIN?.trim() || "tofu";
      const trust: { role: "observe" | "deploy"; original: string; write: Call }[] = [];
      let externalId: string | undefined, workspaceId: string | undefined, environmentId: string | undefined;
      const session = async (): Promise<SessionCredentials> => {
        const out = await invoke(planned("teardown01-sts-assume"), { externalId: externalId! });
        const c = field(out, "Credentials");
        const id = field(c, "AccessKeyId"), secret = field(c, "SecretAccessKey"), token = field(c, "SessionToken");
        if (typeof id !== "string" || typeof secret !== "string" || typeof token !== "string") refuse("the deploy role session could not be read");
        return { accessKeyId: id as string, secretAccessKey: secret as string, sessionToken: token as string };
      };
      const stateInput = async (): Promise<StateDestroyInput> => ({
        tofu, region, backend: { kind: "s3", bucket: stateBucket, region }, stateKey: `zenith/${workspaceId}/${environmentId}/terraform.tfstate`, credentials: await session(),
      });
      const buckets = async () => {
        const out = await invoke(planned("teardown01-tag-read"), { environmentId: environmentId! });
        return ((field(out, "ResourceTagMappingList") as unknown[] | undefined) ?? []).map(r => String(field(r, "ResourceARN"))).filter(arn => BUCKET.test(arn)).sort();
      };
      const probes: string[] = [];
      let step = "preconditions";
      let outcome: { complete: boolean; reason: string };
      try {
        if (env.ZENITH_LIVE_PRODUCT !== "1") refuse("ZENITH_LIVE_PRODUCT=1 is not set; no product scenario ran");
        if (plan.settings.scenario !== "ops-08" || !plan.productCalls?.length) refuse("the plan is not the ops-08 scenario");
        if (!product.probe || !product.tryAction || !product.tryApprove || !product.proposeDeploy || !product.operationStatus) refuse("the browser driver has no probe path");
        step = "tenant A";
        const a = await product.createTenant();
        workspaceId = a.workspaceId;
        step = "connection A";
        const connA = await product.createAwsConnection(a, { accountId: account, region, observeRoleArn: roleArns.observe, deployRoleArn: roleArns.deploy, stateBucket, bootstrapNameSuffix });
        if (!EXTERNAL_ID_NEW.test(connA.externalId)) refuse("the generated ExternalId has an unexpected shape");
        step = "sandbox trust";
        for (const role of ["observe", "deploy"] as const) {
          const current = await invoke(planned(`teardown01-iam-read-${role}`));
          const original = templateExternalId(parsePolicy(field(field(current, "Role"), "AssumeRolePolicyDocument")), principal);
          const write = planned(`teardown01-iam-trust-${role}`);
          trust.push({ role, original, write });
          await invoke(write, { trustDocument: trustDocument(principal, connA.externalId) });
        }
        externalId = connA.externalId;
        step = "connection A verification";
        for (let attempt = 1; ; attempt++) {
          const verified = await product.verifyAws(a, connA.connectionId);
          if (verified.ok) break;
          if (attempt >= propagation.attempts) refuse(`connection.verifyAws did not pass within the propagation bound${verified.why ?? ""}`);
          await sleep(propagation.intervalMs);
        }
        step = "environment A";
        environmentId = (await product.createEnvironment(a, { connectionId: connA.connectionId, region, name: `ops08-${runId.slice(-8).toLowerCase()}` })).environmentId;
        await product.setManifest(a, ops08Manifest(runId, 1));
        step = "deploy A";
        const first = await product.deploy(a, environmentId, "apply");
        if (first.status !== "succeeded") refuse(`the first deploy ended ${/^[a-z_]{1,20}$/.test(first.status) ? first.status : "unknown"}, not succeeded${first.detail ? ` (product: ${first.detail})` : ""}`);
        const deployed = await buckets();
        if (deployed.length !== 1) refuse("the first deploy did not leave exactly one tagged bucket");
        const secretsOfA = [a.workspaceId, connA.externalId, deployed[0]!.slice("arn:aws:s3:::".length)];

        step = "tenant B";
        const b: Deploy01Tenant = await product.createTenant();
        if (b.workspaceId === a.workspaceId) refuse("the second tenant shares the first tenant's workspace");
        const leaks = (text: string) => secretsOfA.some(value => text.includes(value));

        step = "cross-tenant reads";
        for (const [label, endpoint] of [["operation", `/api/platform/v1/operations/${first.operationId}`], ["environment deployments", `/api/environments/${environmentId}/deployments`]] as const) {
          const read = await product.probe(b, endpoint);
          if (read.status >= 200 && read.status < 300 && leaks(read.text)) refuse(`B read A's ${label} (HTTP ${read.status}) and it carried A's data`);
          if (leaks(read.text)) refuse(`B's refused read of A's ${label} leaked A's data`);
          if (read.status >= 200 && read.status < 300) refuse(`B's read of A's ${label} was not refused (HTTP ${read.status})`);
          probes.push(`B read of A's ${label} refused (HTTP ${read.status}), nothing of A in the body`);
        }

        step = "cross-tenant actions";
        const attempts: [string, string, Record<string, unknown>, Record<string, unknown>][] = [
          ["deploy.apply on A's environment", "deploy.apply", { environmentId }, { projectId: b.projectId, environmentId }],
          ["connection.verifyAws on A's connection", "connection.verifyAws", { connectionId: connA.connectionId }, {}],
          ["env.create on A's connection", "env.create", { projectId: b.projectId, name: `ops08b-${runId.slice(-8).toLowerCase()}`, class: "production", connectionId: connA.connectionId, region, approvalRequired: true }, { projectId: b.projectId }],
        ];
        for (const [label, id, input, scope] of attempts) {
          const tried = await product.tryAction(b, id, input, scope);
          if (tried.ok) refuse(`B's ${label} was accepted`);
          probes.push(`B's ${label} refused (HTTP ${tried.status}${tried.why ? `, ${tried.why}` : ""})`);
        }

        step = "confused deputy";
        let deputy: { connectionId: string; externalId: string } | undefined;
        try { deputy = await product.createAwsConnection(b, { accountId: account, region, observeRoleArn: roleArns.observe, deployRoleArn: roleArns.deploy, stateBucket, bootstrapNameSuffix }); }
        catch (error) { if (!(error instanceof Refusal)) throw error; probes.push("B's connection naming A's roles was refused at creation"); }
        if (deputy) {
          if (deputy.externalId === connA.externalId) refuse("B's connection was given A's ExternalId");
          for (let attempt = 1; attempt <= 2; attempt++) {
            if ((await product.verifyAws(b, deputy.connectionId)).ok) refuse("B's connection naming A's roles verified: STS accepted B's ExternalId");
            if (attempt < 2) await sleep(30_000);
          }
          probes.push("B's connection naming A's observe and deploy roles never verified: real STS refused B's own ExternalId (two attempts)");
        }
        if (!(await product.verifyAws(a, connA.connectionId)).ok) refuse("A's connection stopped verifying after B's attempts");

        step = "forged approval";
        await product.setManifest(a, ops08Manifest(runId, 2));
        const proposal = await product.proposeDeploy(a, environmentId);
        const before = await product.operationStatus(a, proposal.operationId);
        const forged = await product.tryApprove(b, proposal.operationId);
        if (forged.ok) refuse("B's approval of A's proposal was accepted");
        const after = await product.operationStatus(a, proposal.operationId);
        if (after.status !== before.status || after.round !== before.round) refuse("A's proposal changed after B's refused approval");
        probes.push(`B's approval of A's pending proposal refused; the proposal stayed ${/^[a-z_]{1,20}$/.test(after.status) ? after.status : "unchanged"} at round ${after.round}`);

        step = "readback";
        if ((await buckets()).length !== 1) refuse("A's environment does not hold exactly its one tagged bucket after the probes");
        outcome = { complete: true, reason: `OPS-08 adversarial probes on AWS (builder-written; independent review recorded apart): tenant A deployed one managed S3 bucket through its own connection; as tenant B: ${probes.join("; ")}; by independent readback A's environment still holds exactly one tagged bucket` };
      } catch (error) {
        outcome = error instanceof Refusal
          ? { complete: false, reason: `OPS-08 not proven at ${step}: ${error.message}` }
          : { complete: false, reason: `OPS-08 not proven at ${step}: unexpected failure (details withheld; no completion claim)` };
      }
      const leaks: string[] = [];
      if (environmentId && externalId) {
        try { await state.destroy(await stateInput()); }
        catch (error) { leaks.push(error instanceof Error && /^(OpenTofu|\d+ resource|The recorded state)/.test(error.message) ? error.message : "state cleanup failed; resources may remain"); }
        try {
          let left: string[] = [];
          for (let attempt = 1; ; attempt++) {
            left = await buckets();
            if (!left.length || attempt >= 4) break;
            await sleep(90_000);
          }
          if (left.length) leaks.push(`${left.length} tagged bucket(s) still present after cleanup`);
        } catch { leaks.push("cleanup re-list failed; resources may remain"); }
      }
      for (const t of [...trust].reverse()) {
        try { await invoke(t.write, { trustDocument: trustDocument(principal, t.original) }); }
        catch { leaks.push(`restoring the ${t.role} sandbox trust failed`); }
      }
      try { await product.close?.(); } catch { /* best-effort browser release */ }
      if (leaks.length) return { complete: false, reason: `${outcome.reason}; cleanup leaks: ${leaks.length} (see the cleanup checks)`, leaks };
      return { ...outcome, leaks };
    },
  };
}
