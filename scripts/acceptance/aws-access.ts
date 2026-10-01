/**
 * `AwsAccess` implementations.
 *
 * `ambientAccess` is the operator's own profile or environment, resolved by the
 * AWS SDK's default credential chain. It is used for the bootstrap identity
 * checks, for changes that stand in for the outside world and for cleanup. It is
 * NOT Zenith's credential: Zenith acts only through the control plane and the
 * broker, in its own worker.
 *
 * `accessFromSession` adapts a broker `AwsSession` (a worker that embeds the
 * harness can hand one in); the credentials stay inside the session.
 *
 * Neither handle exposes the credentials. `childProcessEnv()` returns the
 * variables a child process needs (OpenTofu during cleanup); the caller passes
 * them straight to a spawn with an allowlisted environment and never logs them.
 */
import { STSClient } from "@aws-sdk/client-sts";
import type { AwsClientCtor, AwsSession } from "@/lib/credentials/types";
import type { AwsAccess } from "./types";

const MAX_ATTEMPTS = 3;

export function ambientAccess(input: { accountId: string; region: string }): AwsAccess {
  const { accountId, region } = input;
  const access: AwsAccess = {
    kind: "ambient",
    accountId,
    region,
    client<C>(ctor: AwsClientCtor<C>, overrides?: { region?: string }): C {
      return new ctor({ region: overrides?.region ?? region, maxAttempts: MAX_ATTEMPTS });
    },
    async childProcessEnv() {
      // Resolve through a real client's credential provider so the whole default
      // chain (env, shared config, SSO, IMDS) behaves exactly as it does for the
      // SDK calls above; nothing here reads AWS_* variables by hand.
      const sts = new STSClient({ region });
      try {
        const c = await sts.config.credentials();
        return {
          AWS_ACCESS_KEY_ID: c.accessKeyId,
          AWS_SECRET_ACCESS_KEY: c.secretAccessKey,
          ...(c.sessionToken ? { AWS_SESSION_TOKEN: c.sessionToken } : {}),
          AWS_REGION: region,
          AWS_DEFAULT_REGION: region,
        };
      } finally {
        sts.destroy();
      }
    },
  };
  Object.defineProperty(access, "toJSON", { enumerable: false, value: () => ({ kind: access.kind, accountId, region }) });
  return access;
}

export function accessFromSession(session: AwsSession): AwsAccess {
  const access: AwsAccess = {
    kind: "broker",
    accountId: session.accountId,
    region: session.region,
    client: (ctor, overrides) => session.client(ctor, overrides),
    childProcessEnv: async () => session.childProcessEnv(),
  };
  Object.defineProperty(access, "toJSON", { enumerable: false, value: () => ({ kind: access.kind, accountId: access.accountId, region: access.region }) });
  return access;
}
