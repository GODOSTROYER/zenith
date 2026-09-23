import { describe, expect, it } from "vitest";
import { SUGGESTION_CAP, SUGGESTION_COOLDOWN_MS, canSuggest, initialLandingState, landingReducer, type LandingState, type Suggestion } from "@/app/_landing/landing-state";

const offer = (id: string, chapter: Suggestion["chapter"] = "before"): Suggestion => ({ id, chapter, prompt: "Want to know?", accept: "Yes", walkthrough: "why-queue" });
const restored = (): LandingState => landingReducer(initialLandingState(), { type: "restore", offered: [], dismissed: [], quiet: false, suggestionsShown: 0 });

describe("shared landing state", () => {
  it("keeps selections while a walkthrough only adds presentation", () => {
    let state = restored();
    state = landingReducer(state, { type: "select", node: "results" });
    state = landingReducer(state, { type: "scale", scale: 2 });
    state = landingReducer(state, { type: "walkthrough-start", id: "why-queue" });
    expect(state.walkthrough).toEqual({ id: "why-queue", step: 0 });
    state = landingReducer(state, { type: "walkthrough-step", step: 2 });
    state = landingReducer(state, { type: "walkthrough-end" });
    expect(state.walkthrough).toBeNull();
    expect(state.selected).toBe("results");
    expect(state.scale).toBe(2);
    expect(landingReducer(state, { type: "scale", scale: 9 }).scale).toBe(3);
  });

  it("changing the autonomy selector changes only the explanation state", () => {
    const state = landingReducer(restored(), { type: "autonomy", level: "autonomous" });
    expect(state.autonomy).toBe("autonomous");
    expect(Object.keys(state)).not.toContain("workspace");
  });

  it("offers each suggestion once, honours dismissal, the cooldown and the session cap", () => {
    let state = restored();
    const now = 1_000_000;
    state = landingReducer(state, { type: "suggest", suggestion: offer("a"), now });
    expect(state.suggestion?.id).toBe("a");
    expect(state.offered).toEqual(["a"]);
    // Another offer cannot replace a visible bubble.
    expect(landingReducer(state, { type: "suggest", suggestion: offer("b", "cloud"), now: now + 1 })).toBe(state);
    state = landingReducer(state, { type: "suggestion-dismiss" });
    expect(state.dismissed).toEqual(["a"]);
    expect(state.suggestion).toBeNull();
    // The same suggestion is never offered again this session.
    expect(canSuggest(state, offer("a"), now + SUGGESTION_COOLDOWN_MS + 1)).toBe(false);
    // A different chapter waits for the cooldown.
    expect(canSuggest(state, offer("b", "cloud"), now + SUGGESTION_COOLDOWN_MS - 1)).toBe(false);
    expect(canSuggest(state, offer("b", "cloud"), now + SUGGESTION_COOLDOWN_MS)).toBe(true);
    // Quiet mode, an open panel and a running walkthrough all block offers.
    expect(canSuggest(landingReducer(state, { type: "companion-quiet", quiet: true }), offer("b", "cloud"), now + SUGGESTION_COOLDOWN_MS)).toBe(false);
    expect(canSuggest(landingReducer(state, { type: "companion-open" }), offer("b", "cloud"), now + SUGGESTION_COOLDOWN_MS)).toBe(false);
    expect(canSuggest(landingReducer(state, { type: "walkthrough-start", id: "x" }), offer("b", "cloud"), now + SUGGESTION_COOLDOWN_MS)).toBe(false);
    // The cap ends unprompted offers for the session.
    let capped = state;
    for (let i = 1; i < SUGGESTION_CAP; i++) {
      capped = landingReducer(capped, { type: "suggest", suggestion: offer(`c${i}`, "cloud"), now: now + i * (SUGGESTION_COOLDOWN_MS + 1) });
      capped = landingReducer(capped, { type: "suggestion-expire" });
    }
    expect(capped.suggestionsShown).toBe(SUGGESTION_CAP);
    expect(canSuggest(capped, offer("z", "cloud"), now + 10 * SUGGESTION_COOLDOWN_MS)).toBe(false);
  });

  it("accepting a suggestion starts its walkthrough and clears the bubble", () => {
    let state = landingReducer(restored(), { type: "suggest", suggestion: offer("a"), now: 5 });
    state = landingReducer(state, { type: "suggestion-accept" });
    expect(state.suggestion).toBeNull();
    expect(state.walkthrough).toEqual({ id: "why-queue", step: 0 });
  });

  it("restores session memory and keeps quiet mode", () => {
    const state = landingReducer(initialLandingState(), { type: "restore", offered: ["a"], dismissed: ["a"], quiet: true, suggestionsShown: 1 });
    expect(state.restored).toBe(true);
    expect(state.companion.quiet).toBe(true);
    expect(canSuggest(state, offer("b", "cloud"), Date.now())).toBe(false);
  });

  it("minimizing closes the panel and quiet mode removes a visible bubble", () => {
    let state = landingReducer(restored(), { type: "companion-open", topic: "what-is-zenith" });
    expect(state.companion).toMatchObject({ open: true, topic: "what-is-zenith" });
    state = landingReducer(state, { type: "companion-minimize", minimized: true });
    expect(state.companion).toMatchObject({ open: false, minimized: true });
    let bubbled = landingReducer(restored(), { type: "suggest", suggestion: offer("a"), now: 1 });
    bubbled = landingReducer(bubbled, { type: "companion-quiet", quiet: true });
    expect(bubbled.suggestion).toBeNull();
  });
});
