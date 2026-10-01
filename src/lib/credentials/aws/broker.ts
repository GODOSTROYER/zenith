/**
 * AWS credential broker (ADR-0006).
 *
 * `withSession` turns (verified capability grant + connection id) into a scoped,
 * short-lived AWS session for exactly one callback, then invalidates it.
 *
 * Order of operations — every refusal happens BEFORE any STS call and emits a
 * `credential.denied` event (no secrets, stable reason code):
 *   1. the grant has not expired and names a known capability
 *   2. the connection exists, belongs to the grant's workspace, is an AWS
 *      connection, is `verified` and not revoked
 *   3. the purpose matches the capability (deploy ⇔ mutating)
 *   4. the connection's configuration is acceptable for the mode (role ARN in
 *      the connection's account, ExternalId present for assume-role, no
 *      endpoint override — a token must never be sent to a caller-chosen host)
 *   5. the session policy (caller's or capability-derived) is valid
 *   6. exchange: `oidc_web_identity` → mint a ≤2-minute RS256 token and call
 *      AssumeRoleWithWebIdentity; `aws_assume_role` → AssumeRole with the
 *      per-connection ExternalId from Zenith's own default credential chain;
 *      `runner` → no STS call, the runner transport (if injected) does the work
 *   7. `credential.assumed` is emitted; if the audit sink fails the session is
 *      NOT handed out (no credential without a record)
 *
 * `static_dev` (fixed test credentials against an emulator) is intentionally
 * not supported: the orchestrator put emulator paths on hold.
 *
 * Nothing in this file logs, returns or throws credential material. STS error
 * messages are passed through `redactCredentials` and truncated.
 */
import { randomUUID } from "node:crypto";
import { AssumeRoleCommand, AssumeRoleWithWebIdentityCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { capability as lookupCapability, isCapability } from "@/lib/capabilities/catalog";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import {
  CredentialDeniedError,
  type AwsConnectionConfig,
  type AwsSession,
  type CredentialBroker,
  type CredentialEventSink,
  type CredentialPurpose,
  type CredentialRequest,
  type ConnectionResolver,
  type DenialReason,
  type ProviderConnection,
  type ProviderSession,
  type RunnerAwsTransport,
  type RunnerAwsTransportFactory,
} from "@/lib/credentials/types";
import type { EnvLike } from "../config";
import { CredentialConfigError, OidcError, RunnerTransportUnavailableError, SigningError } from "../errors";
import { AWS_STS_AUDIENCE, mintWorkloadToken } from "../oidc/issuer";
import { redactCredentials } from "../redact";
import type { JwtSigner } from "../signing/types";
import { isAccountId, isExternalId, isRegion, parseRoleArn } from "./arn";
import { validateSessionPolicy, SessionPolicyError } from "./policy";
import { createDirectAwsSession, createRunnerAwsSession, type SessionHandle, type TemporaryCredentials } from "./session";
import { sessionPolicyFor } from "./session-policy";
import { roleSessionName, sessionTagList, sessionTagRecord } from "./tags";

export const DEFAULT_SESSION_SEC = 900;
/** STS floor for DurationSeconds. */
export const MIN_SESSION_SEC = 900;
export const MAX_SESSION_SEC = 3600;
/** Lifetime of the web-identity token minted for one exchange (it is used immediately). */
const WEB_IDENTITY_TOKEN_TTL_SEC = 120;

export interface AwsBrokerOptions {
  resolveConnection: ConnectionResolver;
  /** audit sink; `credential.assumed` failures are fail-closed, `credential.denied` failures are swallowed */
  emit?: CredentialEventSink;
  runnerTransport?: RunnerAwsTransportFactory;
  /** OIDC issuer settings for `oidc_web_identity`; default: environment configuration */
  oidc?: { signer?: JwtSigner; issuer?: string; env?: EnvLike };
  /** STS client factory (tests / custom credential chains); default `new STSClient({ region })` */
  stsClient?: (opts: { region: string }) => STSClient;
  now?: () => Date;
  /** derive a per-capability inline session policy when the request has none (default true) */
  deriveSessionPolicy?: boolean;
  /** put zenith:* session tags in the web-identity token (default true; trust policies must allow sts:TagSession) */
  oidcSessionTags?: boolean;
}

/** Internal signal: converted to CredentialDeniedError + event by `deny()`. */
class Denial extends Error {
  constructor(
    readonly reason: DenialReason,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

interface Plan {
  connection: ProviderConnection;
  config: AwsConnectionConfig;
  purpose: CredentialPurpose;
  roleArn: string;
  /** compact inline policy JSON, if any */
  sessionPolicy?: string;
  durationSec: number;
  workspaceId: string;
  operationId: string;
  capability: string;
}

export class AwsCredentialBroker implements CredentialBroker {
  readonly #o: AwsBrokerOptions;
  readonly #now: () => Date;

  constructor(options: AwsBrokerOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
  }

  /* ------------------------------ public API ------------------------------ */

  async withSession<T>(req: CredentialRequest, fn: (session: ProviderSession) => Promise<T>): Promise<T> {
    return this.withAwsSession(req, fn);
  }

  /** Same as `withSession`, with the session typed as `AwsSession`. */
  async withAwsSession<T>(req: CredentialRequest, fn: (session: AwsSession) => Promise<T>): Promise<T> {
    const grant = req?.grant;
    // Without a workspace on the grant there is nowhere safe to record the denial.
    if (!grant || typeof grant.ws !== "string" || !grant.ws || typeof grant.op !== "string" || !grant.op) {
      throw new CredentialDeniedError("The credential request has no usable capability grant.", { reason: "grant_invalid" });
    }
    const purpose: CredentialPurpose = req.purpose === "deploy" ? "deploy" : "observe";
    let plan: Plan;
    try {
      plan = await this.#plan(req, grant);
    } catch (e) {
      throw await this.#denied(e, {
        workspaceId: grant.ws,
        operationId: grant.op,
        environmentId: grant.env,
        projectId: grant.proj,
        resourceId: grant.res,
        connectionId: req.connectionId,
        purpose,
        capability: grant.cap,
      });
    }

    const handle = await this.#assume(plan, grant, {
      environmentId: grant.env,
      projectId: grant.proj,
      resourceId: grant.res,
    });
    try {
      return await fn(handle.session);
    } finally {
      handle.revoke();
    }
  }

  async verifyConnection(
    connectionId: string,
    opts?: { workspaceId?: string }
  ): Promise<{ ok: boolean; detail: string; accountId?: string }> {
    const operationId = `verify-${cryptoRandomId()}`;
    let connection: ProviderConnection | null;
    try {
      connection = await this.#o.resolveConnection(connectionId);
    } catch {
      return { ok: false, detail: "The connection could not be loaded." };
    }
    if (!connection || (opts?.workspaceId !== undefined && connection.workspaceId !== opts.workspaceId)) {
      return { ok: false, detail: "Connection not found." };
    }
    const base = { workspaceId: connection.workspaceId, operationId, connectionId, purpose: "observe" as const, capability: "connection.verify" };
    let plan: Plan;
    try {
      plan = this.#planVerification(connection, operationId);
    } catch (e) {
      const err = await this.#denied(e, base);
      return { ok: false, detail: err.message };
    }

    let handle: SessionHandle | undefined;
    try {
      handle = await this.#assume(plan, undefined, {});
      const identity = await handle.session.client(STSClient).send(new GetCallerIdentityCommand({}));
      const accountId = identity.Account;
      if (accountId !== plan.config.accountId) {
        return {
          ok: false,
          detail: `The observe role belongs to account ${accountId ?? "unknown"}, but the connection is configured for ${plan.config.accountId}.`,
          accountId,
        };
      }
      return { ok: true, detail: `Assumed the observe role in account ${accountId}.`, accountId };
    } catch (e) {
      if (e instanceof CredentialDeniedError) return { ok: false, detail: e.message };
      if (e instanceof RunnerTransportUnavailableError) {
        return { ok: false, detail: "Runner-mode connections are verified through the runner; its transport is not available here." };
      }
      return { ok: false, detail: `The identity check failed (${errorName(e)}).` };
    } finally {
      handle?.revoke();
    }
  }

  /* -------------------------------- planning ------------------------------- */

  async #plan(req: CredentialRequest, grant: CapabilityGrantClaims): Promise<Plan> {
    const nowSec = Math.floor(this.#now().getTime() / 1000);
    if (!Number.isFinite(grant.exp) || grant.exp <= nowSec) {
      throw new Denial("grant_expired", "The capability grant has expired.");
    }
    if (req.purpose !== "observe" && req.purpose !== "deploy") {
      throw new Denial("purpose_capability_mismatch", 'The credential purpose must be "observe" or "deploy".');
    }
    if (typeof req.connectionId !== "string" || !req.connectionId) {
      throw new Denial("connection_not_found", "The connection was not found.");
    }
    const connection = await this.#o.resolveConnection(req.connectionId);
    if (!connection) throw new Denial("connection_not_found", "The connection was not found.");
    // Deliberately generic: never say which workspace the connection belongs to.
    if (connection.workspaceId !== grant.ws) {
      throw new Denial("workspace_mismatch", "The capability grant does not belong to this connection's workspace.");
    }
    if (connection.config.provider !== "aws") {
      throw new Denial("provider_unsupported", "This broker only issues AWS credentials.");
    }
    if (!isCapability(grant.cap)) throw new Denial("unknown_capability", "The grant names an unknown capability.");
    const mutates = lookupCapability(grant.cap).mutates;
    if (req.purpose === "deploy" && !mutates) {
      throw new Denial("purpose_capability_mismatch", `Capability ${grant.cap} does not change anything, so it cannot use the deploy role.`);
    }
    if (req.purpose === "observe" && mutates) {
      throw new Denial("purpose_capability_mismatch", `Capability ${grant.cap} changes infrastructure and must use the deploy role.`);
    }
    if (connection.status === "revoked") throw new Denial("connection_revoked", "The connection has been revoked.");
    if (connection.status !== "verified") {
      throw new Denial("connection_not_verified", "The connection has not been verified yet.");
    }

    const config = connection.config;
    const roleArn = this.#checkConfig(config, req.purpose);

    const requested = req.durationSec ?? config.sessionDurationSec ?? DEFAULT_SESSION_SEC;
    if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 1) {
      throw new Denial("duration_invalid", "durationSec must be a positive number of seconds.");
    }
    const remaining = grant.exp - nowSec;
    // STS floors DurationSeconds at 900; a shorter grant still gets the floor and the
    // local session guard (below) ends use when the callback settles.
    const durationSec = Math.max(MIN_SESSION_SEC, Math.min(Math.floor(requested), MAX_SESSION_SEC, remaining));

    const sessionPolicy = this.#sessionPolicy(req, grant, config);
    return {
      connection,
      config,
      purpose: req.purpose,
      roleArn,
      sessionPolicy,
      durationSec,
      workspaceId: grant.ws,
      operationId: grant.op,
      capability: grant.cap,
    };
  }

  #planVerification(connection: ProviderConnection, operationId: string): Plan {
    if (connection.status === "revoked") throw new Denial("connection_revoked", "The connection has been revoked.");
    if (connection.config.provider !== "aws") {
      throw new Denial("provider_unsupported", "This broker only verifies AWS connections.");
    }
    const config = connection.config;
    const roleArn = this.#checkConfig(config, "observe");
    return {
      connection,
      config,
      purpose: "observe",
      roleArn,
      durationSec: MIN_SESSION_SEC,
      workspaceId: connection.workspaceId,
      operationId,
      capability: "connection.verify",
    };
  }

  /** Validate the connection's static configuration for `purpose`; returns the role ARN to assume. */
  #checkConfig(config: AwsConnectionConfig, purpose: CredentialPurpose): string {
    if (config.mode === "static_dev") {
      throw new Denial("not_supported", "static_dev credentials are not supported by this broker.");
    }
    if (config.mode !== "oidc_web_identity" && config.mode !== "aws_assume_role" && config.mode !== "runner") {
      throw new Denial("mode_unsupported", "The connection's auth mode is not supported for AWS.");
    }
    if (config.endpoint !== undefined && config.endpoint !== "") {
      // A minted token or STS request must never be sent to a configured host.
      throw new Denial("endpoint_not_permitted", "Endpoint overrides are not permitted for brokered AWS connections.");
    }
    if (!isAccountId(config.accountId) || !isRegion(config.region)) {
      throw new Denial("role_arn_invalid", "The connection's account id or region is malformed.");
    }
    const roleArn = purpose === "deploy" ? config.deployRoleArn : config.observeRoleArn;
    const parsed = parseRoleArn(roleArn);
    if (!parsed) throw new Denial("role_arn_invalid", `The ${purpose} role ARN is not a valid IAM role ARN.`);
    if (parsed.accountId !== config.accountId) {
      throw new Denial("role_account_mismatch", `The ${purpose} role is in a different account than the connection.`);
    }
    if (config.mode === "aws_assume_role" && !isExternalId(config.externalId)) {
      throw new Denial("external_id_missing", "aws_assume_role connections require a valid per-connection ExternalId.");
    }
    return roleArn;
  }

  #sessionPolicy(req: CredentialRequest, grant: CapabilityGrantClaims, config: AwsConnectionConfig): string | undefined {
    try {
      if (req.sessionPolicy !== undefined) return validateSessionPolicy(req.sessionPolicy);
      if (this.#o.deriveSessionPolicy === false) return undefined;
      const derived = sessionPolicyFor(grant.cap, { accountId: config.accountId, region: config.region, environmentId: grant.env });
      return derived ? validateSessionPolicy(derived) : undefined;
    } catch (e) {
      if (e instanceof SessionPolicyError) {
        throw new Denial(req.sessionPolicy !== undefined ? "session_policy_invalid" : "session_policy_unavailable", e.message);
      }
      throw e;
    }
  }

  /* -------------------------------- exchange ------------------------------- */

  async #assume(
    plan: Plan,
    grant: CapabilityGrantClaims | undefined,
    scope: { environmentId?: string; projectId?: string; resourceId?: string }
  ): Promise<SessionHandle> {
    const { config } = plan;
    const eventBase = {
      workspaceId: plan.workspaceId,
      operationId: plan.operationId,
      correlationId: plan.operationId,
      ...scope,
    };
    let handle: SessionHandle;
    try {
      handle = await this.#exchange(plan, grant);
    } catch (e) {
      throw await this.#denied(e, {
        workspaceId: plan.workspaceId,
        operationId: plan.operationId,
        connectionId: plan.connection.id,
        purpose: plan.purpose,
        capability: plan.capability,
        mode: config.mode,
        roleArn: plan.roleArn,
        ...scope,
      });
    }
    try {
      await this.#o.emit?.({
        type: "credential.assumed",
        ...eventBase,
        data: {
          connectionId: plan.connection.id,
          purpose: plan.purpose,
          mode: config.mode,
          durationSec: plan.durationSec,
          roleArn: plan.roleArn,
          capability: plan.capability,
        },
      });
    } catch {
      handle.revoke();
      throw await this.#denied(new Denial("audit_failed", "The credential could not be recorded, so it was not issued."), {
        workspaceId: plan.workspaceId,
        operationId: plan.operationId,
        connectionId: plan.connection.id,
        purpose: plan.purpose,
        capability: plan.capability,
        mode: config.mode,
        roleArn: plan.roleArn,
        ...scope,
      });
    }
    return handle;
  }

  async #exchange(plan: Plan, grant: CapabilityGrantClaims | undefined): Promise<SessionHandle> {
    const { config } = plan;
    const now = this.#now();
    const common = { accountId: config.accountId, region: config.region, now: this.#now };

    if (config.mode === "runner") {
      const expiresAt = new Date(now.getTime() + plan.durationSec * 1000);
      let transport: RunnerAwsTransport | undefined;
      if (this.#o.runnerTransport && grant) {
        try {
          transport = await this.#o.runnerTransport.open({
            connection: plan.connection,
            config,
            grant,
            purpose: plan.purpose,
            roleArn: plan.roleArn,
            expiresAt,
            sessionPolicy: plan.sessionPolicy,
          });
        } catch (e) {
          throw new Denial("runner_unavailable", `The runner transport could not be opened (${errorName(e)}).`);
        }
      }
      return createRunnerAwsSession({ ...common, expiresAt, transport });
    }

    let token: string | undefined;
    if (config.mode === "oidc_web_identity") {
      try {
        token = await mintWorkloadToken(
          {
            workspaceId: plan.connection.workspaceId,
            connectionId: plan.connection.id,
            audience: AWS_STS_AUDIENCE,
            operationId: plan.operationId,
            capability: plan.capability,
            ttlSec: WEB_IDENTITY_TOKEN_TTL_SEC,
            sessionTags: this.#o.oidcSessionTags === false ? undefined : sessionTagRecord(plan),
          },
          { ...this.#o.oidc, now }
        );
      } catch (e) {
        if (e instanceof OidcError || e instanceof CredentialConfigError || e instanceof SigningError) {
          throw new Denial("issuer_unavailable", `The OIDC issuer could not mint a token: ${e.message}`);
        }
        throw e;
      }
    }

    const sts = (this.#o.stsClient ?? ((o) => new STSClient({ region: o.region, maxAttempts: 3 })))({ region: config.region });
    const sessionName = roleSessionName(plan.operationId);
    let out;
    try {
      if (token !== undefined) {
        out = await sts.send(
          new AssumeRoleWithWebIdentityCommand({
            RoleArn: plan.roleArn,
            RoleSessionName: sessionName,
            WebIdentityToken: token,
            DurationSeconds: plan.durationSec,
            ...(plan.sessionPolicy ? { Policy: plan.sessionPolicy } : {}),
          })
        );
      } else {
        out = await sts.send(
          new AssumeRoleCommand({
            RoleArn: plan.roleArn,
            RoleSessionName: sessionName,
            ExternalId: config.externalId,
            DurationSeconds: plan.durationSec,
            Tags: sessionTagList(plan),
            // TransitiveTagKeys deliberately omitted: nothing inherits these tags.
            ...(plan.sessionPolicy ? { Policy: plan.sessionPolicy } : {}),
          })
        );
      }
    } catch (e) {
      throw new Denial("sts_failed", `STS refused the exchange (${errorName(e)}): ${sanitizeMessage(e)}`, { stsError: errorName(e) });
    } finally {
      sts.destroy();
    }

    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
      throw new Denial("sts_failed", "STS returned no usable credentials.");
    }
    const assumedAccount = /^arn:[^:]+:sts::(\d{12}):/.exec(out.AssumedRoleUser?.Arn ?? "")?.[1];
    if (assumedAccount !== undefined && assumedAccount !== config.accountId) {
      throw new Denial("role_account_mismatch", "STS issued credentials for a different account than the connection.");
    }
    const credentials: TemporaryCredentials = {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration ?? new Date(now.getTime() + plan.durationSec * 1000),
    };
    return createDirectAwsSession({ ...common, credentials, expiresAt: credentials.expiration });
  }

  /* --------------------------------- events -------------------------------- */

  async #denied(
    cause: unknown,
    ctx: {
      workspaceId: string;
      operationId?: string;
      connectionId: string;
      purpose: CredentialPurpose;
      capability?: string;
      mode?: string;
      roleArn?: string;
      environmentId?: string;
      projectId?: string;
      resourceId?: string;
    }
  ): Promise<CredentialDeniedError> {
    const denial =
      cause instanceof Denial
        ? cause
        : cause instanceof CredentialDeniedError
          ? new Denial(cause.reason ?? "sts_failed", cause.message)
          : null;
    if (!denial) throw cause; // programming error or infrastructure failure: not a credential decision
    try {
      await this.#o.emit?.({
        type: "credential.denied",
        workspaceId: ctx.workspaceId,
        operationId: ctx.operationId,
        correlationId: ctx.operationId ?? ctx.connectionId,
        environmentId: ctx.environmentId,
        projectId: ctx.projectId,
        resourceId: ctx.resourceId,
        data: {
          connectionId: ctx.connectionId,
          purpose: ctx.purpose,
          ...(ctx.mode ? { mode: ctx.mode } : {}),
          ...(ctx.roleArn ? { roleArn: ctx.roleArn } : {}),
          ...(ctx.capability ? { capability: ctx.capability } : {}),
          reason: denial.reason,
          ...denial.extra,
        },
      });
    } catch {
      // A failed denial record must not turn a refusal into a different error.
    }
    return new CredentialDeniedError(denial.message, { reason: denial.reason });
  }
}

// External names are data: accept exact, bounded diagnostic codes only. A
// syntax check or truncation would still leak opaque secrets placed in a name.
const SAFE_ERROR_NAMES = new Set([
  "AccessDenied", "AccessDeniedException", "ExpiredToken", "ExpiredTokenException",
  "IDPCommunicationError", "IDPCommunicationErrorException", "IDPRejectedClaim", "IDPRejectedClaimException",
  "InvalidIdentityToken", "InvalidIdentityTokenException", "MalformedPolicyDocument", "MalformedPolicyDocumentException",
  "PackedPolicyTooLarge", "PackedPolicyTooLargeException", "RegionDisabled", "RegionDisabledException",
  "Throttling", "ThrottlingException", "TooManyRequestsException", "ServiceUnavailable", "InternalFailure",
  "TimeoutError", "NetworkingError",
]);

function errorName(e: unknown): string {
  const name = e instanceof Error ? e.name : "Error";
  return SAFE_ERROR_NAMES.has(name) ? name : "Error";
}

function sanitizeMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : "";
  return redactCredentials(message).replace(/\s+/g, " ").slice(0, 300);
}

function cryptoRandomId(): string {
  return randomUUID().slice(0, 8);
}
