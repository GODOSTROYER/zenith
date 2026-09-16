import { describe, expect, it } from "vitest";
import { reviewDisplay } from "@/lib/agent-access/control/review";
import type { Operation } from "@/lib/agent-access/control/journal";
import type { Database } from "@/lib/db/types";
import { redact } from "@/lib/agent-access/security";

const data = {
  workspaces: [{ id: "ws1", name: "Acme", slug: "acme" }, { id: "ws2", name: "Other", slug: "other" }],
  members: [],
  connections: [
    { id: "c1", workspaceId: "ws1", provider: "sandbox", label: "Sandbox", region: "local", status: "healthy" },
    { id: "c2", workspaceId: "ws2", provider: "aws", label: "Their AWS", region: "us-east-1", status: "healthy" },
  ],
  projects: [
    { id: "p1", workspaceId: "ws1", name: "Shop", slug: "shop", workingManifest: { services: [{ id: "svc1", name: "web" }], resources: [], routes: [] } },
    { id: "p2", workspaceId: "ws1", name: "Fresh", slug: "fresh", workingManifest: { services: [], resources: [], routes: [] } },
    { id: "px", workspaceId: "ws2", name: "Foreign", slug: "foreign", workingManifest: { services: [], resources: [], routes: [] } },
  ],
  environments: [{ id: "e1", projectId: "p1", name: "Staging" }],
  revisions: [],
  deployments: [{ id: "d1", projectId: "p1", changeSummary: "Add web" }],
  findings: [{ id: "f1", projectId: "px", title: "Foreign finding" }],
  navigatorRuns: [],
  alertRules: [],
  alertEvents: [],
  alertOutbox: [],
  settings: { alertChannels: [{ id: "ch1", workspaceId: "ws1", kind: "webhook", name: "Ops hook", target: "https://hooks.example/secret-path", secret: "s3cr3t" }] },
} as unknown as Database;

const op = (over: Partial<Operation>): Operation =>
  ({
    id: "op1", digest: "d", subject: "u1", integrationId: "i1", createdAt: "", expiresAt: "", phase: "prepared",
    action: "project.create", input: {}, target: { workspaceId: "ws1" }, fingerprint: "", plan: {}, requestKey: "k",
    ...over,
  }) as Operation;

describe("reviewDisplay", () => {
  it("names the workspace for a workspace-level proposal and lists the request", () => {
    const view = reviewDisplay(op({ plan: { kind: "project.create" }, input: { name: "Fresh", slug: "fresh", withEnvironment: true, connectionId: "c1" } }), data);
    expect(view).toMatchObject({ kind: "project.create", title: "Create a project", level: "workspace", workspace: { id: "ws1", name: "Acme" } });
    expect(view.project).toBeUndefined();
    expect(view.fields).toEqual([
      { label: "Name", text: "Fresh", mono: false },
      { label: "URL slug", text: "fresh", mono: true },
      { label: "Also create an environment", text: "yes" },
      { label: "Connection", text: "Sandbox · sandbox (c1)", mono: true },
    ]);
  });

  it("links the created project once the operation succeeded, only inside the workspace", () => {
    const done = op({ phase: "succeeded", result: { ok: true, data: { projectId: "p2", slug: "fresh", environmentId: "e9" } } });
    expect(reviewDisplay(done, data).created).toEqual({ projectId: "p2", name: "Fresh", slug: "fresh", environmentId: "e9", href: "/p/fresh" });
    expect(reviewDisplay({ ...done, result: { data: { projectId: "px" } } }, data).created).toBeUndefined();
    expect(reviewDisplay({ ...done, phase: "prepared" }, data).created).toBeUndefined();
  });

  it("shows env.set's key and value, resolves the service, and survives redact()", () => {
    const view = reviewDisplay(
      op({ action: "system.setEnvVar", plan: { kind: "system.edit" }, target: { workspaceId: "ws1", projectId: "p1" }, input: { projectId: "p1", serviceId: "svc1", key: "LOG_LEVEL", value: "debug" } }),
      data
    );
    expect(view).toMatchObject({ title: "Set an environment variable", level: "project", project: { name: "Shop", slug: "shop" } });
    expect((redact(view) as typeof view).fields).toEqual([
      { label: "Service", text: "web (svc1)", mono: true },
      { label: "Key", text: "LOG_LEVEL", mono: true },
      { label: "Value", text: "debug", mono: true },
    ]);
  });

  it("titles every new kind", () => {
    const actions = ["project.importCompose", "project.applyBlueprint", "project.importResources", "workspace.rename", "connection.create", "connection.check",
      "connection.disconnect", "alerts.createRule", "alerts.updateRule", "alerts.deleteRule", "alerts.acknowledge", "alerts.testChannel", "alerts.deleteChannel",
      "alerts.updateChannel", "security.dismissFinding", "security.reopenFinding", "security.resolveFinding", "app.suspend", "app.resume", "env.create", "env.clone",
      "env.update", "env.setBudget", "env.setConnection", "env.updatePolicies", "deploy.cancel", "ops.restartService", "ops.scaleService", "system.setSecret", "system.removeSecret"];
    for (const action of actions) expect(reviewDisplay(op({ action }), data).title, action).toMatch(/^[A-Z][a-z]/);
    expect(reviewDisplay(op({ action: "project.importCompose" }), data).title).toBe("Create a project from a Compose file");
    expect(reviewDisplay(op({ action: "project.applyBlueprint", target: { workspaceId: "ws1", projectId: "p1" } }), data).title).toBe("Apply a blueprint to this project");
    expect(reviewDisplay(op({ action: "env.clone", target: { workspaceId: "ws1", projectId: "p1", environmentId: "e1" } }), data)).toMatchObject({ level: "environment", environment: { name: "Staging" } });
  });

  it("never projects a credential and never resolves another workspace's ids", () => {
    const view = reviewDisplay(
      op({ action: "alerts.updateChannel", input: { channelId: "ch1", name: "Ops", enabled: false, target: "https://x", secret: "y", secretValue: "z", apiKey: "k", webhookUrl: "w" } }),
      data
    );
    expect(view.fields).toEqual([
      { label: "Channel", text: "Ops hook (ch1)", mono: true },
      { label: "Name", text: "Ops", mono: false },
      { label: "Enabled", text: "no" },
    ]);
    expect(JSON.stringify(view)).not.toMatch(/hooks\.example|s3cr3t/);
    const foreign = reviewDisplay(op({ action: "security.dismissFinding", target: { workspaceId: "ws1", projectId: "p1" }, input: { findingId: "f1", connectionId: "c2" } }), data);
    expect(foreign.fields.map((f) => f.text)).toEqual(["f1", "c2"]);
  });

  it("summarises bulky input instead of echoing it", () => {
    const view = reviewDisplay(op({ action: "project.importCompose", input: { name: "x", composeYaml: "services:\n  web:\n    image: nginx" } }), data);
    expect(view.fields[1]).toEqual({ label: "Compose file", text: "3 lines, 33 characters" });
    const long = reviewDisplay(op({ action: "system.setEnvVar", input: { key: "K", value: "v".repeat(900) } }), data);
    expect(long.fields[1].text).toMatch(/… \(900 characters\)$/);
  });
});
