/**
 * The invocation sentinel.
 *
 * The gateway's central promise is that a denied request never reaches app
 * code or the broker (PLAN-R3 G14). A promise like that is only worth what a
 * test can check, so every path that actually touches an artifact's bytes or
 * calls the per-app data store increments a counter here first, and every
 * denial test asserts both counters are still zero.
 *
 * These are process-wide numbers, not per-request state: they exist for tests
 * and for a health probe to read, never for admission decisions.
 */

/** What the gateway has actually invoked in this process. */
export interface GatewayTelemetry {
  /** Incremented once per artifact response whose bytes were read from the store. */
  artifactServed: number;
  /** Incremented once per call into a per-app `TrackerDataStore` method. */
  brokerInvoked: number;
}

const counters: GatewayTelemetry = { artifactServed: 0, brokerInvoked: 0 };

/** The live counters. Read them; use the `note…` helpers to change them. */
export const gatewayTelemetry: GatewayTelemetry = counters;

/** Called immediately before an artifact's bytes are handed to a response. */
export function noteArtifactServed(): void {
  counters.artifactServed += 1;
}

/** Called immediately before a `TrackerDataStore` method runs. */
export function noteBrokerInvoked(): void {
  counters.brokerInvoked += 1;
}

/** Tests: start from zero. */
export function resetGatewayTelemetry(): void {
  counters.artifactServed = 0;
  counters.brokerInvoked = 0;
}
