/**
 * Types private to the GCP provider package. The cross-module contracts
 * (`GcpSession`, `GcpConnectionConfig`, `ResourceDriver`) live in their own
 * modules and are not changed here.
 */
import type { CredentialPurpose, GcpSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";

export type GcpDriverContext = DriverContext<GcpSession>;

/**
 * What `createGcpSession` returns: the `GcpSession` contract plus an explicit
 * `close()` and the purpose it was minted for. The access token is not a
 * member of this object.
 */
export interface GcpSessionHandle extends GcpSession {
  readonly purpose: CredentialPurpose;
  readonly closed: boolean;
  /** invalidate immediately; further `authorizedFetch`/`childProcessEnv` calls throw */
  close(): void;
  toJSON(): Record<string, unknown>;
}
