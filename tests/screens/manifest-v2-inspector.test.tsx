/** Actual inspector renderers; the reviewed-action control is a capture stub. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanFirstProps } from "@/components/inspector/plan-first";
import { productSeed, v1, v2 } from "../actions/manifest-v2-fixture";

let data = productSeed(v1());
vi.mock("@/components/shell/project-context", () => ({ useProjectData: () => ({
  project: data.projects![0], findings: [], changesets: {}, selectedEnvId: "env", selectedEnv: data.environments![0],
}) }));
vi.mock("@/components/inspector/plan-first", () => ({ PlanFirst: ({ actionId, input }: PlanFirstProps) =>
  <output data-testid={actionId}>{JSON.stringify(input)}</output> }));
import { Inspector } from "@/components/inspector/inspector";
import { ServiceEditor } from "@/components/inspector/service-editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined; host = undefined;
});

describe("Manifest V2 inspector compatibility", () => {
  it.each([v1, v2])("renders connection labels without changing the manifest (%#)", (make) => {
    const manifest = make();
    manifest.routes.push({ id: "route", host: "example.test", pathPrefix: "/", tls: true, managedDns: true });
    manifest.bindings.push({ id: "binding", from: "route", to: "svc-web", capability: "http" });
    data = productSeed(manifest);
    const before = JSON.stringify(manifest);
    const html = renderToStaticMarkup(<Inspector target={{ kind: "binding", bindingId: "binding" }} onClose={() => {}} onSelect={() => {}} />);
    expect(html).toContain("example.test → web");
    expect(html).toContain("http connection");
    expect(JSON.stringify(manifest)).toBe(before);
  });

  it.each([v1, v2])("submits only the service field edit through its existing action (%#)", (make) => {
    const manifest = make();
    data = productSeed(manifest);
    const before = JSON.stringify(manifest);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<ServiceEditor service={manifest.services[0]} />));
    const replicas = host.querySelector<HTMLInputElement>('input[value="1"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(replicas, "2");
      replicas.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(JSON.parse(host.querySelector('[data-testid="system.updateService"]')!.textContent!))
      .toEqual({ serviceId: "svc-web", replicas: 2 });
    expect(host.textContent).toContain("/mo est.");
    expect(JSON.stringify(manifest)).toBe(before);
  });
});
