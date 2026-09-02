/**
 * The language front-end's failure paths.
 *
 * The model only ever rewrites a goal into the planner's grammar, so the one
 * thing that must never happen is a *partial* rewrite being treated as a whole
 * one: "deploy to production" truncated to "deploy to prod" still parses, and
 * would plan a different run than the one that was asked for. Every fallback
 * has to say which parser actually read the goal, too — the UI prints it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyManifest, type Project } from "@/lib/domain/types";

process.env.ORRERY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orrery-nav-llm-"));
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.ORRERY_LLM_MODEL = "claude-test-model";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const { normalizeGoal, plannerMode, plannerModel } = await import("@/lib/navigator/llm");

const GOAL = "please put the new cache in front of the api and ship it to production";

const project: Project = {
  id: "proj-1",
  workspaceId: "ws-1",
  name: "Atlas",
  slug: "atlas",
  workingManifest: emptyManifest(),
  createdAt: new Date().toISOString(),
  origin: { type: "blank" },
};

const reply = (stop_reason: string, text: string) => ({
  stop_reason,
  content: [{ type: "text", text }],
});

afterEach(() => create.mockReset());

describe("normalizeGoal", () => {
  it("uses the translation when the model finished", async () => {
    create.mockResolvedValue(reply("end_turn", "add a redis cache named cache, then deploy to production"));
    const out = await normalizeGoal(GOAL, project, []);
    expect(out.text).toBe("add a redis cache named cache, then deploy to production");
    expect(out.usedLlm).toBe(true);
    expect(out.model).toBe("claude-test-model");
  });

  it("discards a translation cut off at the token limit", async () => {
    // The dangerous case: this parses cleanly, and it is not what was asked.
    create.mockResolvedValue(reply("max_tokens", "add a redis cache named cache, then deploy to prod"));
    const out = await normalizeGoal(GOAL, project, []);
    expect(out.text).toBe(GOAL); // the raw goal, for the deterministic parser
    expect(out.usedLlm).toBe(false);
    expect(out.fallbackReason).toMatch(/token limit|token/i);
    expect(out.fallbackReason).toMatch(/deterministic parser/);
  });

  it("falls back on a refusal, and never wears the model's name for it", async () => {
    create.mockResolvedValue(reply("refusal", ""));
    const out = await normalizeGoal(GOAL, project, []);
    expect(out.usedLlm).toBe(false);
    expect(out.model).toBeUndefined();
    expect(out.fallbackReason).toMatch(/declined/);
  });

  it("falls back when the model is unreachable", async () => {
    create.mockRejectedValue(new Error("ECONNREFUSED"));
    const out = await normalizeGoal(GOAL, project, []);
    expect(out.text).toBe(GOAL);
    expect(out.usedLlm).toBe(false);
    expect(out.fallbackReason).toMatch(/ECONNREFUSED/);
  });

  it("reads the model and the key through lib/env, not raw process.env", () => {
    expect(plannerModel()).toBe("claude-test-model");
    expect(plannerMode()).toBe("llm");
    // an empty key is the same as no key — lib/env's `present()` rule
    process.env.ANTHROPIC_API_KEY = "   ";
    expect(plannerMode()).toBe("deterministic");
    process.env.ANTHROPIC_API_KEY = "test-key-not-used";
  });
});
