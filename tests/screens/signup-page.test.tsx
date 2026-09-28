import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import SignupPage, { generateMetadata } from "@/app/(auth)/signup/page";

const state = vi.hoisted(() => ({ gated: true }));
vi.mock("@/lib/waitlist/config", () => ({ waitlistGateEnabled: () => state.gated }));
vi.mock("@/components/auth/auth-form", () => ({
  AuthForm: () => <form aria-label="Account creation" />,
  AuthFormSkeleton: () => null,
}));

beforeEach(() => { state.gated = true; });

it("server-renders a waitlist notice instead of mounting public signup when gated", async () => {
  const next = "/invite?invite=workspace-token";
  const html = renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve({ next }) }));
  const host = document.createElement("div");
  host.innerHTML = html;
  expect(host.querySelector("form")).toBeNull();
  expect(host.querySelector("input")).toBeNull();
  expect(host.querySelector('a[href^="/waitlist"]')?.getAttribute("href")).toBe(`/waitlist?next=${encodeURIComponent(next)}`);
  expect(host.querySelector('a[href^="/login"]')?.getAttribute("href")).toBe(`/login?next=${encodeURIComponent(next)}`);
  expect(generateMetadata().title).toBe("Join the waitlist");
});

it("discards unsafe destinations and ambiguous repeated query values in the signup notice", async () => {
  for (const next of ["//other.example", ["/invite", "/account"]]) {
    const html = renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve({ next }) }));
    expect(html).toContain('href="/waitlist"');
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("?next=");
  }
});

it("retains normal signup on deployments without the admission gate", async () => {
  state.gated = false;
  const html = renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('aria-label="Account creation"');
  expect(generateMetadata().title).toBe("Create account");
});
