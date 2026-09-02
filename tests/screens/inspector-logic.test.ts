/**
 * What the inspector actually sends, what it refuses to pretend it can send,
 * and how an apply is keyed. All pure — no rendering needed to check any of it.
 */
import { describe, expect, it } from "vitest";
import {
  idempotencyKey,
  planIsInvalid,
  serviceDraft,
  serviceEditIssues,
  serviceUpdateInput,
} from "@/components/inspector/logic";
import type { Service } from "@/lib/domain/types";

const SERVICE: Service = {
  id: "svc_1",
  name: "api",
  kind: "web",
  source: { type: "image", image: "ghcr.io/acme/api:1" },
  size: "small",
  replicas: 2,
  port: 3000,
  healthPath: "/healthz",
  env: [],
  ownership: "managed",
};

describe("serviceUpdateInput", () => {
  it("sends nothing but the id when nothing moved", () => {
    expect(serviceUpdateInput(SERVICE, serviceDraft(SERVICE))).toEqual({ serviceId: "svc_1" });
  });

  it("treats an emptied Replicas as unchanged instead of scaling to zero", () => {
    const d = { ...serviceDraft(SERVICE), replicas: "" };
    expect(serviceUpdateInput(SERVICE, d)).not.toHaveProperty("replicas");
  });

  it("still sends 0 replicas when 0 was actually typed", () => {
    const d = { ...serviceDraft(SERVICE), replicas: "0" };
    expect(serviceUpdateInput(SERVICE, d).replicas).toBe(0);
  });

  it("sends an out-of-range value so the server rejects it out loud", () => {
    const d = { ...serviceDraft(SERVICE), replicas: "99" };
    expect(serviceUpdateInput(SERVICE, d).replicas).toBe(99);
  });

  it("does not treat an emptied Name as a rename", () => {
    const d = { ...serviceDraft(SERVICE), name: "   " };
    expect(serviceUpdateInput(SERVICE, d)).not.toHaveProperty("name");
  });

  it("does not send an emptied Port as 0", () => {
    const d = { ...serviceDraft(SERVICE), port: "" };
    expect(serviceUpdateInput(SERVICE, d)).not.toHaveProperty("port");
  });

  it("sends nothing for a source mode switched to an empty repository", () => {
    const d = { ...serviceDraft(SERVICE), sourceMode: "repo" as const, repo: "" };
    const input = serviceUpdateInput(SERVICE, d);
    expect(input).not.toHaveProperty("repo");
    expect(input).not.toHaveProperty("image");
  });

  it("sends repo and ref together, defaulting the ref", () => {
    const d = { ...serviceDraft(SERVICE), sourceMode: "repo" as const, repo: "github.com/acme/api", ref: "" };
    expect(serviceUpdateInput(SERVICE, d)).toMatchObject({
      repo: "github.com/acme/api",
      ref: "main",
    });
  });
});

describe("serviceEditIssues", () => {
  it("is silent on an untouched draft", () => {
    expect(serviceEditIssues(SERVICE, serviceDraft(SERVICE))).toEqual([]);
  });

  it("names Port as unclearable rather than letting Apply look available", () => {
    const issues = serviceEditIssues(SERVICE, { ...serviceDraft(SERVICE), port: "" });
    expect(issues.map((i) => i.field)).toContain("Port");
    expect(issues[0].reason).toMatch(/cannot be cleared/i);
  });

  it("explains an emptied Image", () => {
    expect(
      serviceEditIssues(SERVICE, { ...serviceDraft(SERVICE), image: "" }).map((i) => i.field)
    ).toContain("Image");
  });

  it("explains a source switch that has no repository yet", () => {
    const issues = serviceEditIssues(SERVICE, {
      ...serviceDraft(SERVICE),
      sourceMode: "repo",
      repo: "",
    });
    expect(issues.map((i) => i.field)).toContain("Repository");
  });

  it("does not demand a port from a kind that does not listen", () => {
    const issues = serviceEditIssues(SERVICE, {
      ...serviceDraft(SERVICE),
      kind: "static",
      port: "",
    });
    expect(issues.map((i) => i.field)).not.toContain("Port");
  });

  it("says an emptied Name is not a rename", () => {
    expect(
      serviceEditIssues(SERVICE, { ...serviceDraft(SERVICE), name: "" }).map((i) => i.field)
    ).toContain("Name");
  });
});

describe("idempotencyKey", () => {
  it("is stable for the same intent, so a retry replays", () => {
    const a = idempotencyKey("system.updateService", { serviceId: "s", replicas: 2 }, { v: 1 });
    const b = idempotencyKey("system.updateService", { replicas: 2, serviceId: "s" }, { v: 1 });
    expect(a).toBe(b);
  });

  it("changes when the intent changes", () => {
    const a = idempotencyKey("system.updateService", { serviceId: "s", replicas: 2 }, { v: 1 });
    const b = idempotencyKey("system.updateService", { serviceId: "s", replicas: 3 }, { v: 1 });
    expect(a).not.toBe(b);
  });

  it("changes when the base state moved, so the same edit runs again", () => {
    const a = idempotencyKey("system.bind", { from: "a", to: "b" }, { bindings: [] });
    const b = idempotencyKey("system.bind", { from: "a", to: "b" }, { bindings: ["x"] });
    expect(a).not.toBe(b);
  });

  it("keeps the action id readable in the key", () => {
    expect(idempotencyKey("system.bind", {}, {})).toMatch(/^system\.bind-/);
  });

  it("survives undefined and nested values", () => {
    expect(() => idempotencyKey("a", { x: undefined, y: [1, { z: null }] }, undefined)).not.toThrow();
  });
});

describe("planIsInvalid", () => {
  it("recognises the plan runAction returns for a schema rejection", () => {
    expect(planIsInvalid({ summary: "Invalid input." })).toBe(true);
  });

  it("leaves a real plan alone", () => {
    expect(planIsInvalid({ summary: "Updates service \"api\"" })).toBe(false);
  });
});
