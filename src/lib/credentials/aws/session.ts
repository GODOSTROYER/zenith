/**
 * `AwsSession` implementations.
 *
 * The session object exposes client FACTORIES and a scrubbed child-process
 * environment — no accessor for the credentials. It is a plain object whose
 * only enumerable data properties are non-secret (provider, account, region,
 * expiry, transport), so `JSON.stringify(session)` and `console.log(session)`
 * are safe by construction; the credentials live in a closure.
 *
 * Invalidation: after the broker's callback settles the session is revoked.
 * A revoked (or time-expired) session refuses to build clients, refuses
 * `childProcessEnv()`, and every client it already built refuses `send()` and
 * refuses to hand out credentials again (the SDK asks the credential provider
 * on each request attempt, including retries).
 *
 * Honest limit: inside the callback this is the worker's own trusted code.
 * A caller that reaches into `client.config.credentials()` can still read the
 * credentials during the session (S3 presigning legitimately needs them). This
 * is defence against accidents — logging, persisting, returning a session — not
 * a sandbox against hostile code in the worker.
 */
import type { AwsClientCtor, AwsSession, RunnerAwsTransport } from "@/lib/credentials/types";
import { RunnerTransportUnavailableError, SessionExpiredError } from "../errors";
import { isRegion } from "./arn";

export interface TemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export interface SessionHandle {
  session: AwsSession;
  /** invalidate now; idempotent */
  revoke(): void;
}

interface CommonInput {
  accountId: string;
  region: string;
  expiresAt: Date;
  now: () => Date;
}

const MAX_ATTEMPTS = 3;

/**
 * Wrap an SDK client so `send()` refuses once the session is inactive. A
 * Proxy (rather than patching the instance) keeps the guard in place even if
 * a test framework stubs `Client.prototype.send` after construction.
 */
export function guardClient<C>(client: C, assertActive: () => void): C {
  if (client === null || typeof client !== "object" || typeof (client as { send?: unknown }).send !== "function") {
    throw new Error("Refusing to hand out a client that cannot be session-guarded (it has no send method).");
  }
  return new Proxy(client as object, {
    get(target, prop) {
      if (prop === "send") {
        return (...args: unknown[]): Promise<unknown> => {
          try {
            assertActive();
          } catch (e) {
            return Promise.reject(e);
          }
          return (target as { send: (...a: unknown[]) => Promise<unknown> }).send(...args);
        };
      }
      return Reflect.get(target, prop);
    },
  }) as C;
}

function assertRegionOverride(region: string | undefined): string | undefined {
  if (region === undefined) return undefined;
  if (!isRegion(region)) throw new Error("Invalid AWS region override.");
  return region;
}

/** Direct (or otherwise locally-credentialed) session: SDK clients use the brokered temporary credentials. */
export function createDirectAwsSession(
  input: CommonInput & { credentials: TemporaryCredentials; transport?: "direct" | "emulator" }
): SessionHandle {
  let credentials: TemporaryCredentials | undefined = input.credentials;
  let revoked = false;

  const active = (): boolean => !revoked && credentials !== undefined && input.now().getTime() < input.expiresAt.getTime();
  const assertActive = (): void => {
    if (!active()) throw new SessionExpiredError();
  };

  const provider = async (): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration: Date;
  }> => {
    assertActive();
    const c = credentials!;
    return {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
      expiration: c.expiration,
    };
  };

  const session: AwsSession = {
    provider: "aws",
    accountId: input.accountId,
    region: input.region,
    expiresAt: input.expiresAt.toISOString(),
    transport: input.transport ?? "direct",
    client<C>(ctor: AwsClientCtor<C>, overrides?: { region?: string }): C {
      assertActive();
      const region = assertRegionOverride(overrides?.region) ?? input.region;
      const client = new ctor({ region, credentials: provider, maxAttempts: MAX_ATTEMPTS });
      return guardClient(client, assertActive);
    },
    childProcessEnv(): Record<string, string> {
      assertActive();
      const c = credentials!;
      return {
        AWS_ACCESS_KEY_ID: c.accessKeyId,
        AWS_SECRET_ACCESS_KEY: c.secretAccessKey,
        AWS_SESSION_TOKEN: c.sessionToken,
        AWS_REGION: input.region,
        AWS_DEFAULT_REGION: input.region,
      };
    },
  };
  // Only non-secret data is serialisable, explicitly.
  Object.defineProperty(session, "toJSON", {
    enumerable: false,
    value: () => ({
      provider: session.provider,
      accountId: session.accountId,
      region: session.region,
      expiresAt: session.expiresAt,
      transport: session.transport,
    }),
  });

  return {
    session,
    revoke() {
      revoked = true;
      credentials = undefined; // best-effort: drop our reference
    },
  };
}

/**
 * Runner-mode session (ADR-0006): credentials never leave the customer's
 * environment, so there are none here. Without an injected transport every
 * client request is refused with `runner_transport_unavailable`.
 */
export function createRunnerAwsSession(input: CommonInput & { transport?: RunnerAwsTransport }): SessionHandle {
  let revoked = false;
  const assertActive = (): void => {
    if (revoked || input.now().getTime() >= input.expiresAt.getTime()) throw new SessionExpiredError();
  };
  const session: AwsSession = {
    provider: "aws",
    accountId: input.accountId,
    region: input.region,
    expiresAt: input.expiresAt.toISOString(),
    transport: "runner",
    client<C>(ctor: AwsClientCtor<C>, overrides?: { region?: string }): C {
      assertActive();
      if (!input.transport) throw new RunnerTransportUnavailableError();
      const region = assertRegionOverride(overrides?.region);
      return guardClient(input.transport.client(ctor, region ? { region } : undefined), assertActive);
    },
    childProcessEnv(): Record<string, string> {
      assertActive();
      throw new RunnerTransportUnavailableError(
        "Runner-mode sessions have no local credentials; the tool must run on the customer's runner."
      );
    },
  };
  Object.defineProperty(session, "toJSON", {
    enumerable: false,
    value: () => ({
      provider: session.provider,
      accountId: session.accountId,
      region: session.region,
      expiresAt: session.expiresAt,
      transport: session.transport,
    }),
  });
  return {
    session,
    revoke() {
      revoked = true;
      const t = input.transport;
      if (t?.close) void Promise.resolve(t.close()).catch(() => undefined);
    },
  };
}
