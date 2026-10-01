/** Opt-in external mTLS handshake/namespace checks. Never runs against an implicit endpoint. */
import { Connection } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
import { connectionOptionsFor, temporalConfigFromEnv } from "@/lib/workflows/config";

const enabled = process.env.ZENITH_TEST_TEMPORAL_MTLS === "1";

describe.skipIf(!enabled)("external Temporal mTLS (ZENITH_TEST_TEMPORAL_MTLS=1)", () => {
  it.each(["web", "worker"] as const)("%s transport authenticates and reads the configured namespace", async (transport) => {
    if (!process.env.ZENITH_TEMPORAL_ADDRESS?.trim() || !process.env.ZENITH_TEMPORAL_NAMESPACE?.trim()
      || !process.env.ZENITH_TEMPORAL_TLS_CERT_FILE?.trim() || !process.env.ZENITH_TEMPORAL_TLS_KEY_FILE?.trim()) {
      throw new Error("The mTLS test requires explicit Temporal address, namespace and client cert/key file variables.");
    }
    const config = temporalConfigFromEnv();
    let connection: Connection | NativeConnection | undefined;
    try {
      const options = connectionOptionsFor(config);
      connection = transport === "web"
        ? await Connection.connect({ ...options, connectTimeout: 5000 })
        : await NativeConnection.connect(options);
      const response = await connection.withDeadline(Date.now() + 5000, () =>
        connection!.workflowService.describeNamespace({ namespace: config.namespace }));
      expect(response.namespaceInfo?.name === config.namespace).toBe(true);
    } catch {
      // A failed live SDK call can echo PEM/key bytes: never expose its cause.
      throw new Error("Temporal mTLS handshake or namespace check failed; inspect server trust, client identity and permissions.");
    } finally {
      try { await connection?.close(); }
      catch { throw new Error("Temporal mTLS test connection cleanup failed."); }
    }
  }, 20_000);
});
