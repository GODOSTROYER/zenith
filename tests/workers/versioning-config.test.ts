/** PROD-OPS-03: worker deployment-version (build id) routing configuration. Pure; no Temporal server. */
import { describe, expect, it } from "vitest";
import type { NativeConnection } from "@temporalio/worker";
import { executionWorkerConfigFromEnv, WorkerConfigError } from "../../workers/execution/config";
import { workerOptions } from "../../workers/execution/run";
import { DEFAULT_WORKER_DEPLOYMENT_NAME, describeWorkerVersioning, workerDeploymentOptionsFor, workerVersioningFromEnv } from "@/lib/workflows/versioning";

const connection = {} as NativeConnection;
const build = (env: Record<string, string>) => {
  const config = executionWorkerConfigFromEnv(env);
  return workerOptions({ config, connection, activities: {} as never, workflows: { workflowBundle: { code: "x", sourceMap: "" }, origin: "prebuilt-bundle" } });
};

describe("worker versioning configuration", () => {
  it("is off by default and adds no deployment options (today's behaviour is unchanged)", () => {
    expect(workerVersioningFromEnv({})).toBeUndefined();
    expect(executionWorkerConfigFromEnv({}).versioning).toBeUndefined();
    expect(build({})).not.toHaveProperty("workerDeploymentOptions");
    expect(describeWorkerVersioning(undefined)).toEqual({ versioning: "off" });
  });

  it("auto_upgrade routes by deployment version and lets running workflows move to the current build", () => {
    const options = build({ ZENITH_WORKER_VERSIONING: "auto_upgrade", ZENITH_WORKER_BUILD_ID: "sha256:abc123" });
    expect(options.workerDeploymentOptions).toEqual({
      version: { deploymentName: DEFAULT_WORKER_DEPLOYMENT_NAME, buildId: "sha256:abc123" },
      useWorkerVersioning: true,
      defaultVersioningBehavior: "AUTO_UPGRADE",
    });
  });

  it("pinned keeps running workflows on the build that started them", () => {
    const config = workerVersioningFromEnv({ ZENITH_WORKER_VERSIONING: "pinned", ZENITH_WORKER_BUILD_ID: "2026-10-07-a", ZENITH_WORKER_DEPLOYMENT_NAME: "zenith-exec-prod" })!;
    expect(workerDeploymentOptionsFor(config)).toMatchObject({ defaultVersioningBehavior: "PINNED", version: { deploymentName: "zenith-exec-prod", buildId: "2026-10-07-a" } });
    expect(describeWorkerVersioning(config)).toEqual({ versioning: "pinned", deployment: "zenith-exec-prod", buildId: "2026-10-07-a" });
  });

  it("refuses ambiguous or incomplete configuration at startup", () => {
    for (const env of [
      { ZENITH_WORKER_VERSIONING: "on" },
      { ZENITH_WORKER_VERSIONING: "pinned" },
      { ZENITH_WORKER_VERSIONING: "auto_upgrade", ZENITH_WORKER_BUILD_ID: "has.dot" },
      { ZENITH_WORKER_VERSIONING: "auto_upgrade", ZENITH_WORKER_BUILD_ID: "ok", ZENITH_WORKER_DEPLOYMENT_NAME: "bad name" },
      { ZENITH_WORKER_BUILD_ID: "forgotten-switch" },
    ]) expect(() => executionWorkerConfigFromEnv(env), JSON.stringify(env)).toThrow(WorkerConfigError);
  });
});
