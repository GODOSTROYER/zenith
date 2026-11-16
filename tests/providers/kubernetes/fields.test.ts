/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffPaths, normalizeForDiff } from "@/lib/providers/kubernetes/diff";
import { extractOwned } from "@/lib/providers/kubernetes/fields";
import { serverSideApply } from "@/lib/providers/kubernetes/apply";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { startFakeK8s, type FakeK8s } from "./fake-api";
import { ENV_ID, NS, networkNode, serviceNode, sessionFor } from "./helpers";

describe("extractOwned", () => {
  const live = (managedFields: unknown[], over: Record<string, unknown> = {}) => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: "shop", labels: { a: "1", b: "2" }, annotations: { x: "y" }, managedFields },
    spec: {
      replicas: 3,
      template: {
        spec: {
          containers: [
            { name: "app", image: "img:1", env: [{ name: "A", value: "1" }, { name: "B", value: "2" }], args: ["--x", "--y"], ports: [{ containerPort: 80, protocol: "TCP", name: "http" }] },
            { name: "sidecar", image: "side:1" },
          ],
          finalizers: ["a", "b"],
        },
      },
    },
    ...over,
  });

  it("projects only the fields the manager owns, selecting list items by merge key", () => {
    const fields = {
      "f:metadata": { "f:labels": { ".": {}, "f:a": {} } },
      "f:spec": {
        "f:replicas": {},
        "f:template": {
          "f:spec": {
            "f:containers": {
              'k:{"name":"app"}': {
                ".": {},
                "f:image": {},
                "f:name": {},
                "f:args": {},
                "f:env": { 'k:{"name":"B"}': { ".": {}, "f:name": {}, "f:value": {} } },
                "f:ports": { 'k:{"containerPort":80,"protocol":"TCP"}': { ".": {}, "f:containerPort": {}, "f:protocol": {} } },
              },
            },
          },
        },
      },
    };
    const owned = extractOwned(live([{ manager: "zenith", operation: "Apply", fieldsType: "FieldsV1", fieldsV1: fields }]), "zenith")!;
    expect(owned).toEqual({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "web", namespace: "shop", labels: { a: "1" } },
      spec: {
        replicas: 3,
        template: {
          spec: {
            containers: [{ name: "app", image: "img:1", args: ["--x", "--y"], env: [{ name: "B", value: "2" }], ports: [{ containerPort: 80, protocol: "TCP" }] }],
          },
        },
      },
    });
  });

  it("handles set (`v:`) and index (`i:`) selectors and ignores malformed keys", () => {
    const fields = { "f:spec": { "f:template": { "f:spec": { "f:finalizers": { 'v:"b"': {}, "i:0": {}, "k:{bad": {} } } } } };
    const owned = extractOwned(live([{ manager: "zenith", operation: "Apply", fieldsV1: fields }]), "zenith")!;
    expect((owned.spec as any).template.spec.finalizers).toEqual(["a", "b"]);
  });

  it("only trusts Apply entries of the named manager without a subresource", () => {
    const f = { "f:spec": { "f:replicas": {} } };
    expect(extractOwned(live([{ manager: "zenith", operation: "Update", fieldsV1: f }]), "zenith")).toBeUndefined();
    expect(extractOwned(live([{ manager: "kubectl", operation: "Apply", fieldsV1: f }]), "zenith")).toBeUndefined();
    expect(extractOwned(live([{ manager: "zenith", operation: "Apply", subresource: "status", fieldsV1: f }]), "zenith")).toBeUndefined();
    expect(extractOwned(live([]), "zenith")).toBeUndefined();
    expect(extractOwned({ metadata: {} } as any, "zenith")).toBeUndefined();
  });

  it("omits fields the object no longer has and does not mutate the live object", () => {
    const l = live([{ manager: "zenith", operation: "Apply", fieldsV1: { "f:spec": { "f:gone": {}, "f:replicas": {} } } }]);
    const snapshot = JSON.stringify(l);
    const owned = extractOwned(l, "zenith")!;
    expect(owned.spec).toEqual({ replicas: 3 });
    (owned.spec as any).replicas = 99;
    expect(JSON.stringify(l)).toBe(snapshot);
  });
});

describe("against the fake's server-side apply", () => {
  let fake: FakeK8s;
  beforeAll(async () => {
    fake = await startFakeK8s();
  });
  afterAll(async () => {
    await fake.close();
  });

  it("extracting what zenith owns from a live Deployment reproduces what was applied", async () => {
    const { objects } = renderGraph([networkNode(), serviceNode()], { environmentId: ENV_ID });
    await serverSideApply(objects, await sessionFor(fake, []), { environmentId: ENV_ID });
    const live = fake.get("Deployment", NS, "web")!;
    const applied = objects.find((o) => o.kind === "Deployment")!;
    const owned = extractOwned(live, "zenith")!;
    expect(owned.metadata).toEqual(applied.metadata);
    expect(owned.spec).toEqual(applied.spec);
    // server defaults were added to the live object but are not Zenith's
    expect((live.spec as any).progressDeadlineSeconds).toBe(600);
    expect((owned.spec as any).progressDeadlineSeconds).toBeUndefined();
  });

  it("documents why day-two changes use a second manager: a partial apply under the SAME manager deletes what it owned", async () => {
    const f = await startFakeK8s();
    try {
      const { objects } = renderGraph([networkNode(), serviceNode()], { environmentId: ENV_ID });
      await serverSideApply(objects, await sessionFor(f, []), { environmentId: ENV_ID });
      const url = `${f.url}/apis/apps/v1/namespaces/${NS}/deployments/web?fieldManager=zenith`;
      const partial = { apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace: NS }, spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": "x" } } } } };
      const res = await fetch(url, { method: "PATCH", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/apply-patch+yaml" }, body: JSON.stringify(partial) });
      expect(res.status).toBe(200);
      const after = f.get("Deployment", NS, "web") as any;
      expect(after.spec.template.spec).toBeUndefined(); // the pod spec Zenith owned is gone
      expect(after.spec.replicas).toBe(1); // Zenith had asked for 2; it is back to the server default
      expect(after.spec.selector).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});

describe("diff paths", () => {
  it("ignores server-owned noise and reports keyed list items by key", () => {
    const a = { metadata: { name: "x", resourceVersion: "1", uid: "u", managedFields: [{}], annotations: { "deployment.kubernetes.io/revision": "1" } }, status: { a: 1 }, spec: { containers: [{ name: "app", image: "a" }, { name: "b", image: "b" }] } };
    const b = { metadata: { name: "x", resourceVersion: "2", uid: "u", managedFields: [], annotations: { "deployment.kubernetes.io/revision": "2" } }, status: { a: 2 }, spec: { containers: [{ name: "b", image: "b" }, { name: "app", image: "c" }] } };
    expect(diffPaths(normalizeForDiff(a), normalizeForDiff(b))).toEqual(["spec.containers[name=app].image"]);
    expect(diffPaths({ a: 1 }, { a: 1 })).toEqual([]);
    expect(diffPaths({ "a/b": 1 }, { "a/b": 2 })).toEqual(['["a/b"]']);
    expect(diffPaths([1, 2], [1, 3])).toEqual(["[1]"]);
  });

  it("reports Secret data as key names only", () => {
    const n = normalizeForDiff({ kind: "Secret", metadata: { name: "s" }, data: { value: "c2VjcmV0" } });
    expect(JSON.stringify(n)).not.toContain("c2VjcmV0");
    expect(n.data).toEqual({ value: "<value>" });
  });

  it("bounds the number of paths", () => {
    const big = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    expect(diffPaths({}, big, 50)).toHaveLength(50);
  });
});
