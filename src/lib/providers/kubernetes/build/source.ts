/** Immutable tenant source custody using the separate build writer, shared by native and managed targets. */
import { createHash } from "node:crypto";
import { ApiException, type KubernetesObject } from "@kubernetes/client-node";
import type { DriverContext } from "@/lib/drivers/types";
import { StepFailedError } from "@/lib/execution/errors";
import { digest } from "@/lib/controlplane/digest";
import { createK8sClient, readObject } from "../client";
import { dig } from "../util";
import { createBuildCustody, type BuildCustodyPort } from "./custody";
import { assertBuildNodes } from "./nodes";
import { sourceName } from "./render";

export const MAX_ISOLATED_SOURCE_BYTES = 700 * 1024;
export interface IsolatedSourceStore {
  upload(ctx: DriverContext, bundle: { archive: Uint8Array; sha256: string; bytes: number }): Promise<{ name: string; namespace: string }>;
}
export function createIsolatedSourceStore(custody: BuildCustodyPort = createBuildCustody()): IsolatedSourceStore {
  return {
    async upload(ctx, bundle) {
      if (!/^[a-f0-9]{64}$/.test(bundle.sha256) || bundle.bytes < 1 || bundle.bytes !== bundle.archive.length ||
          bundle.bytes > MAX_ISOLATED_SOURCE_BYTES || createHash("sha256").update(bundle.archive).digest("hex") !== bundle.sha256) {
        throw new StepFailedError("The approved source archive is invalid or exceeds the isolated hand-off limit of 700 KiB.");
      }
      return custody.withSessions(ctx, async (writer, verifier, profile) => {
        const c = profile.config, name = sourceName(ctx.environmentId, bundle.sha256);
        const client = createK8sClient(writer, { signal: ctx.signal });
        await client.guard.assert(c.namespace);
        await assertBuildNodes(createK8sClient(verifier, { signal: ctx.signal }), c);
        const secret = {
          apiVersion: "v1", kind: "Secret", metadata: { name, namespace: c.namespace,
            labels: { "app.kubernetes.io/managed-by": "zenith" },
            annotations: { "zenith.dev/environment": ctx.environmentId, "zenith.dev/workspace-id": ctx.workspaceId,
              "zenith.dev/source-digest": bundle.sha256 } },
          immutable: true, type: "Opaque", data: { "source.tar.gz": Buffer.from(bundle.archive).toString("base64") },
        };
        try { await client.objects.create(secret as KubernetesObject, undefined, undefined, "zenith-isolated-source"); }
        catch (error) { if (!(error instanceof ApiException) || error.code !== 409) throw error; }
        const live = await readObject(client, { apiVersion: "v1", kind: "Secret", namespace: c.namespace, name });
        if (!live || live.immutable !== true || live.type !== "Opaque" || digest(live.data) !== digest(secret.data) ||
            dig(live, "metadata", "annotations", "zenith.dev/environment") !== ctx.environmentId ||
            dig(live, "metadata", "annotations", "zenith.dev/workspace-id") !== ctx.workspaceId ||
            dig(live, "metadata", "annotations", "zenith.dev/source-digest") !== bundle.sha256) {
          throw new StepFailedError("The immutable source hand-off does not match the approved tenant bytes; it will not be overwritten.");
        }
        return { name, namespace: c.namespace };
      });
    },
  };
}
