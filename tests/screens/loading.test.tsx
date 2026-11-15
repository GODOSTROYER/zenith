import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import Loading from "@/app/loading";
import OverviewLoading from "@/app/(product)/overview/loading";
import AppsLoading from "@/app/(product)/apps/loading";
import SystemLoading from "@/app/(product)/p/[slug]/loading";
import SourceLoading from "@/app/(product)/p/[slug]/source/loading";
import DeploysLoading from "@/app/(product)/p/[slug]/deploys/loading";
import RevisionsLoading from "@/app/(product)/p/[slug]/revisions/loading";
import ObserveLoading from "@/app/(product)/p/[slug]/observe/loading";
import SecurityLoading from "@/app/(product)/p/[slug]/security/loading";
import ActivityLoading from "@/app/(product)/p/[slug]/activity/loading";
import NavigatorLoading from "@/app/(product)/p/[slug]/navigator/loading";
import SettingsLoading from "@/app/(product)/p/[slug]/settings/loading";
import { Skeleton } from "@/components/ui/skeleton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it.each([
  ["page", "page", Loading],
  ["overview", "overview", OverviewLoading],
  ["apps", "cards", AppsLoading],
  ["system", "canvas", SystemLoading],
  ["source", "editor", SourceLoading],
  ["deployments", "list", DeploysLoading],
  ["revisions", "list", RevisionsLoading],
  ["observability", "overview", ObserveLoading],
  ["security findings", "list", SecurityLoading],
  ["activity", "list", ActivityLoading],
  ["Navigator", "conversation", NavigatorLoading],
  ["settings", "settings", SettingsLoading],
] as const)("loads %s in its content region with one accessible announcement", (label, variant, Fallback) => {
  act(() => root.render(<Fallback />));
  const surface = host.querySelector(`[data-screen-loading="${variant}"]`);
  const status = host.querySelector('[role="status"]');
  expect(surface).not.toBeNull();
  expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(status?.textContent).toBe(`Loading ${label}…`);
  expect(status?.getAttribute("aria-live")).toBe("polite");
  // A busy ancestor would defer the loading announcement until it disappeared.
  expect(status?.closest('[aria-busy="true"]')).toBeNull();
  expect(surface?.querySelector('[aria-busy="true"]')).not.toBeNull();
  const placeholders = host.querySelectorAll("[data-skeleton]");
  expect(placeholders.length).toBeGreaterThan(5);
  for (const placeholder of placeholders) expect(placeholder.getAttribute("aria-hidden")).toBe("true");
  expect(host.querySelector('svg.zl, .zenith-boot, .zenith-route-loading, [data-page-curtain], [role="dialog"]')).toBeNull();
  expect(host.querySelector("button, a, input, [tabindex]")).toBeNull();
});

it("removes the fallback as soon as content is available", () => {
  act(() => root.render(<SourceLoading />));
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  act(() => root.render(<h1>Source</h1>));
  expect(host.textContent).toBe("Source");
  expect(host.querySelector("[data-screen-loading], [data-skeleton], [role=status]")).toBeNull();
});

it("preserves skeleton sizing and rounded avatars without adding a second status", () => {
  act(() => root.render(<Skeleton width="60%" height={28} round className="custom-size" />));
  const skeleton = host.querySelector<HTMLElement>("[data-skeleton]")!;
  expect(skeleton.style.width).toBe("60%");
  expect(skeleton.style.height).toBe("28px");
  expect(skeleton.classList.contains("rounded-full")).toBe(true);
  expect(skeleton.classList.contains("custom-size")).toBe(true);
  expect(skeleton.getAttribute("aria-hidden")).toBe("true");
  expect(host.querySelector("[role=status]")).toBeNull();
});
