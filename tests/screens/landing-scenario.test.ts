import { describe, expect, it } from "vitest";
import { Manifest } from "@/lib/domain/types";
import { diffManifests } from "@/lib/domain/graph";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import {
  AGENT_STEPS, CURRENT_SYSTEM, ESTIMATE, EXAMPLE_NODE_IDS, NODE_META, PROPOSED_BINDING_IDS, PROPOSED_CHANGE, PROPOSED_IDS, PROPOSED_SYSTEM,
  SCALE_STEPS, costDriver,
} from "@/app/_landing/scenario";
import { AUTONOMY_EXAMPLE, AUTONOMY_GLOSS, CHAPTER_TOPICS, SUGGESTIONS, TOPICS, WALKTHROUGHS, contextLine, matchTopic, topicById } from "@/app/_landing/gimbal-guide";
import { AUTONOMY_LEVELS } from "@/lib/navigator/shared";
import { CHAPTERS, initialLandingState } from "@/app/_landing/landing-state";

describe("the example system", () => {
  it("is made of valid product manifests priced by the product cost model", () => {
    expect(Manifest.safeParse(CURRENT_SYSTEM).success).toBe(true);
    expect(Manifest.safeParse(PROPOSED_SYSTEM).success).toBe(true);
    expect(ESTIMATE.current).toBe(monthlyCostUsd(CURRENT_SYSTEM));
    expect(ESTIMATE.proposed).toBe(monthlyCostUsd(PROPOSED_SYSTEM));
    expect(ESTIMATE).toEqual({ current: 22, proposed: 30, delta: 8 });
  });

  it("derives the plan from the product diff, with only low-risk additions", () => {
    expect(PROPOSED_CHANGE).toEqual(diffManifests(CURRENT_SYSTEM, PROPOSED_SYSTEM));
    expect(PROPOSED_CHANGE.items.map((i) => i.op)).toEqual(Array(6).fill("create"));
    expect(PROPOSED_CHANGE.items.every((i) => i.risk === "low")).toBe(true);
    expect(PROPOSED_CHANGE.items.map((i) => `${i.nodeType}:${i.nodeId}`)).toEqual(["service:process-worker", "resource:process-jobs", ...PROPOSED_BINDING_IDS.map((id) => `binding:${id}`)]);
    expect(PROPOSED_CHANGE.projectedMonthlyUsd).toBe(30);
    expect(PROPOSED_CHANGE.warnings).toEqual([]);
  });

  it("marks exactly the proposed nodes and connections and explains every part", () => {
    for (const id of PROPOSED_IDS) {
      expect(CURRENT_SYSTEM.services.some((s) => s.id === id) || CURRENT_SYSTEM.resources.some((r) => r.id === id)).toBe(false);
    }
    expect(PROPOSED_BINDING_IDS).toEqual(["api-jobs", "worker-jobs", "worker-uploads", "worker-results"]);
    for (const id of EXAMPLE_NODE_IDS) {
      expect(NODE_META[id].label.length).toBeGreaterThan(3);
      expect(NODE_META[id].role.endsWith(".")).toBe(true);
    }
    expect(PROPOSED_SYSTEM.bindings.every((b) => b.note)).toBe(true);
  });

  it("prices every growth step with the cost model and never exceeds the replica ceiling", () => {
    let previous = 0;
    for (const step of SCALE_STEPS) {
      expect(Manifest.safeParse(step.manifest).success).toBe(true);
      expect(step.estimate).toBe(monthlyCostUsd(step.manifest));
      expect(step.estimate).toBeGreaterThan(previous);
      previous = step.estimate;
      expect(step.manifest.services.every((s) => s.replicas <= 10)).toBe(true);
    }
    expect(SCALE_STEPS[0].estimate).toBe(ESTIMATE.proposed);
    expect(costDriver(SCALE_STEPS[3].manifest)).toBe("process-worker");
  });

  it("keeps the agent sequence complete", () => {
    expect(AGENT_STEPS).toHaveLength(6);
    expect(AGENT_STEPS[3].quote).toBe("Help me get this application ready to run on Zenith.");
    // No step shows a terminal command.
    expect(AGENT_STEPS.some((s) => /\/plugin|npm |npx /.test(s.text))).toBe(false);
  });
});

describe("Gimbal's curated guide", () => {
  it("explains every autonomy level in the product's vocabulary", () => {
    for (const level of AUTONOMY_LEVELS) {
      expect(AUTONOMY_GLOSS[level].length).toBeGreaterThan(10);
      expect(AUTONOMY_EXAMPLE[level]).toMatch(/Gimbal|edits|plan/);
    }
    // Below approve, nothing executes; bounded refuses rather than asks; autonomous still starts from Run.
    expect(AUTONOMY_EXAMPLE.observe).toMatch(/executes nothing/i);
    expect(AUTONOMY_EXAMPLE.plan).toMatch(/executes nothing/i);
    expect(AUTONOMY_EXAMPLE.bounded).toMatch(/refuses/);
    expect(AUTONOMY_EXAMPLE.autonomous).toMatch(/press Run/);
  });

  it("matches typed questions to written answers and admits when it has none", () => {
    expect(matchTopic("Can I use my own AWS account?")?.id).toBe("own-aws");
    expect(matchTopic("how does the claude code plugin link")?.id).toBe("agent-deployment");
    expect(matchTopic("are you a real ai?")?.id).toBe("live-ai");
    expect(matchTopic("gdpr")?.id).toBe("compliance");
    expect(matchTopic("what is the weather like")).toBeNull();
    expect(matchTopic("")).toBeNull();
    for (const ids of Object.values(CHAPTER_TOPICS)) for (const id of ids) expect(topicById(id)).not.toBeNull();
    expect(TOPICS.find((t) => t.id === "pricing")?.answer).toMatch(/no published pricing/);
  });

  it("offers one suggestion per chapter that opens a walkthrough in that chapter", () => {
    for (const chapter of CHAPTERS.map((c) => c.id)) {
      const suggestion = SUGGESTIONS[chapter];
      if (!suggestion) continue;
      const walkthrough = WALKTHROUGHS[suggestion.walkthrough];
      expect(walkthrough, suggestion.walkthrough).toBeDefined();
      expect(walkthrough.steps[0].chapter).toBe(chapter === "hero" ? "before" : chapter);
      expect(walkthrough.steps.length).toBeGreaterThan(0);
    }
    const state = initialLandingState();
    for (const walkthrough of Object.values(WALKTHROUGHS)) {
      for (const step of walkthrough.steps) {
        expect(step.text(state).length).toBeGreaterThan(20);
        expect(step.highlight(state)).not.toBeNull();
      }
    }
  });

  it("describes the page state explicitly rather than guessing intent", () => {
    const state = initialLandingState();
    expect(contextLine(state)).toBe("Zenith · welcome");
    expect(contextLine({ ...state, chapter: "before" })).toBe("The system · proposed change · Processing queue");
    expect(contextLine({ ...state, chapter: "scenarios", scale: 2 })).toMatch(/100,000 uploads a day · \$163\.50 a month/);
    expect(contextLine({ ...state, chapter: "gimbal", autonomy: "bounded" })).toBe("Gimbal and control · level 4, bounded");
  });
});
