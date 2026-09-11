"use client";

import { useEffect, useReducer } from "react";
import { CURRENT_DEMO_MANIFEST, PROPOSED_DEMO_MANIFEST, DEMO_STEPS, type DemoSelection } from "./demo-fixture";

export type DemoStage = "review" | "applying" | "recorded" | "restored";
export type DemoPhase = "current" | "proposed" | "applying" | "recorded" | "restored";
export interface DemoRecord { revision: number; kind: "baseline" | "simulation" | "restore"; description: string }
export interface DemoState {
  stage: DemoStage;
  inspected: "current" | "proposed";
  viewedRevision: number | null;
  selected: DemoSelection;
  reviewed: boolean;
  step: number;
  currentRevision: number;
  currentHasQueue: boolean;
  history: DemoRecord[];
}
export type DemoAction =
  | { type: "inspect"; view: "current" | "proposed" }
  | { type: "view-history"; revision: number }
  | { type: "select"; resource: DemoSelection }
  | { type: "review"; value: boolean }
  | { type: "run" }
  | { type: "advance" }
  | { type: "restore" }
  | { type: "reset" };

export function initialDemoState(): DemoState {
  return { stage: "review", inspected: "proposed", viewedRevision: null, selected: "atlas-jobs", reviewed: false, step: 0, currentRevision: 8, currentHasQueue: false, history: [{ revision: 8, kind: "baseline", description: "Original synthetic configuration" }] };
}

export function revisionDemoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case "reset": return initialDemoState();
    case "select": return { ...state, selected: action.resource };
    case "inspect":
      if (state.stage === "applying") return state;
      return { ...state, viewedRevision: null, inspected: action.view, stage: state.stage === "restored" && action.view === "proposed" ? "review" : state.stage, selected: action.view === "current" && !state.currentHasQueue ? "atlas-api" : state.selected };
    case "view-history": {
      const record = state.history.find((entry) => entry.revision === action.revision);
      if (state.stage === "applying" || !record) return state;
      return { ...state, viewedRevision: record.revision, selected: record.kind === "simulation" ? state.selected : "atlas-api" };
    }
    case "review": return state.stage === "review" ? { ...state, reviewed: action.value } : state;
    case "run":
      if (state.stage !== "review" || !state.reviewed) return state;
      return { ...state, stage: "applying", viewedRevision: null, inspected: "proposed", selected: "atlas-jobs", step: 0 };
    case "advance":
      if (state.stage !== "applying") return state;
      if (state.step < DEMO_STEPS.length - 1) return { ...state, step: state.step + 1 };
      return { ...state, stage: "recorded", step: DEMO_STEPS.length, currentRevision: state.currentRevision + 1, currentHasQueue: true, inspected: "current", history: [...state.history, { revision: state.currentRevision + 1, kind: "simulation", description: "Added atlas-jobs and two bindings · simulated" }] };
    case "restore":
      if (state.stage !== "recorded") return state;
      return { ...state, stage: "restored", viewedRevision: null, inspected: "current", selected: "atlas-api", reviewed: false, step: 0, currentRevision: state.currentRevision + 1, currentHasQueue: false, history: [...state.history, { revision: state.currentRevision + 1, kind: "restore", description: "Restored revision 08 configuration · simulated" }] };
  }
}

export function deriveDemo(state: DemoState) {
  const proposedRevision = state.currentHasQueue ? state.currentRevision : state.currentRevision + 1;
  const historicalRecord = state.history.find((record) => record.revision === state.viewedRevision);
  if (historicalRecord) {
    const phase: DemoPhase = historicalRecord.kind === "simulation" ? "recorded" : historicalRecord.kind === "restore" ? "restored" : "current";
    return { manifest: historicalRecord.kind === "simulation" ? PROPOSED_DEMO_MANIFEST : CURRENT_DEMO_MANIFEST, phase, revision: historicalRecord.revision, proposedRevision, isRunning: state.stage === "applying", isHistorical: true };
  }
  const showingProposal = state.inspected === "proposed" || state.stage === "applying";
  const manifest = showingProposal || state.currentHasQueue ? PROPOSED_DEMO_MANIFEST : CURRENT_DEMO_MANIFEST;
  const phase: DemoPhase = state.stage === "applying" ? "applying" : state.stage === "recorded" ? "recorded" : state.stage === "restored" ? "restored" : showingProposal ? "proposed" : "current";
  return { manifest, phase, revision: showingProposal ? proposedRevision : state.currentRevision, proposedRevision, isRunning: state.stage === "applying", isHistorical: false };
}

export function useRevisionDemo() {
  const [state, dispatch] = useReducer(revisionDemoReducer, undefined, initialDemoState);
  useEffect(() => {
    if (state.stage !== "applying") return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => dispatch({ type: "advance" }), reduced ? 0 : 900);
    return () => window.clearTimeout(timer);
  }, [state.stage, state.step]);
  return {
    state, ...state, ...deriveDemo(state),
    inspect: (view: "current" | "proposed") => dispatch({ type: "inspect", view }),
    viewHistory: (revision: number) => dispatch({ type: "view-history", revision }),
    select: (resource: DemoSelection) => dispatch({ type: "select", resource }),
    setReviewed: (value: boolean) => dispatch({ type: "review", value }),
    run: () => dispatch({ type: "run" }),
    restore: () => dispatch({ type: "restore" }),
    reset: () => dispatch({ type: "reset" }),
  };
}
export type RevisionDemo = ReturnType<typeof useRevisionDemo>;
