/**
 * One shared presentation state for the whole landing page.
 *
 * Every demonstration and Gimbal read from here, so the architecture, the
 * plan, the estimate, the scenario, the deployment path and the autonomy
 * explanation can never disagree with one another or with what Gimbal says.
 * Nothing in this file touches a workspace, an account or a provider: it is
 * the page's own memory of what the visitor is looking at.
 */
import type { AutonomyLevel } from "@/lib/domain/types";
import type { GimbalMood } from "@/components/navigator/gimbal-renderer";
import type { ExampleNodeId } from "./scenario";

export const CHAPTERS = [
  { id: "hero", title: "Zenith", nav: null },
  { id: "before", title: "The system", nav: "System" },
  { id: "scenarios", title: "Growth", nav: "Growth" },
  { id: "agents", title: "Your agents", nav: "Agents" },
  { id: "gimbal", title: "Gimbal and control", nav: "Gimbal" },
  { id: "cloud", title: "Your cloud", nav: "Cloud" },
  { id: "close", title: "Ownership", nav: null },
] as const;
export type ChapterId = (typeof CHAPTERS)[number]["id"];
export const chapterTitle = (id: ChapterId): string => CHAPTERS.find((c) => c.id === id)?.title ?? "Zenith";

export type SystemView = "current" | "proposed";

/** What a walkthrough or an answer may emphasise. Presentation only. */
export interface Highlight {
  nodes?: ExampleNodeId[];
  bindings?: string[];
  /** changeset items, keyed `${nodeType}:${nodeId}` */
  items?: string[];
  /** agent sequence steps, zero-based */
  steps?: number[];
  level?: AutonomyLevel;
  /** a named region of a chapter, e.g. "estimate", "assumptions" or an orbit card */
  region?: string;
}

export interface Suggestion {
  id: string;
  chapter: ChapterId;
  prompt: string;
  accept: string;
  walkthrough: string;
}

export interface CompanionState {
  open: boolean;
  minimized: boolean;
  /** no proactive suggestions; help stays reachable */
  quiet: boolean;
  mood: GimbalMood;
  /** the curated topic currently answered */
  topic: string | null;
  /** the visitor's own words, when they typed a question */
  question: string | null;
}

export interface LandingState {
  chapter: ChapterId;
  view: SystemView;
  selected: ExampleNodeId;
  scale: number;
  autonomy: AutonomyLevel;
  agentStep: number;
  walkthrough: { id: string; step: number } | null;
  companion: CompanionState;
  suggestion: Suggestion | null;
  /** suggestion ids shown this session */
  offered: string[];
  /** suggestion ids the visitor declined this session */
  dismissed: string[];
  suggestionsShown: number;
  lastSuggestionAt: number | null;
  /** true once session memory has been read on the client */
  restored: boolean;
}

export type LandingAction =
  | { type: "chapter"; chapter: ChapterId }
  | { type: "view"; view: SystemView }
  | { type: "select"; node: ExampleNodeId }
  | { type: "scale"; scale: number }
  | { type: "autonomy"; level: AutonomyLevel }
  | { type: "agent-step"; step: number }
  | { type: "walkthrough-start"; id: string }
  | { type: "walkthrough-step"; step: number }
  | { type: "walkthrough-end" }
  | { type: "companion-open"; topic?: string | null }
  | { type: "companion-close" }
  | { type: "companion-minimize"; minimized: boolean }
  | { type: "companion-quiet"; quiet: boolean }
  | { type: "companion-topic"; topic: string | null; question?: string | null }
  | { type: "mood"; mood: GimbalMood }
  | { type: "suggest"; suggestion: Suggestion; now: number }
  | { type: "suggestion-dismiss" }
  | { type: "suggestion-expire" }
  | { type: "suggestion-accept" }
  | { type: "restore"; offered: string[]; dismissed: string[]; quiet: boolean; suggestionsShown: number };

/** Gimbal waits this long for settled, visible reading before it offers anything. */
export const SUGGESTION_DELAY_MS = 12_000;
/** After one suggestion, the next chapter waits at least this long. */
export const SUGGESTION_COOLDOWN_MS = 45_000;
/** At most this many unprompted suggestions per session. */
export const SUGGESTION_CAP = 4;
/** An ignored bubble leaves on its own after this long (unless it has focus). */
export const SUGGESTION_TTL_MS = 14_000;

export function initialLandingState(): LandingState {
  return {
    chapter: "hero",
    view: "proposed",
    selected: "process-jobs",
    scale: 0,
    autonomy: "approve",
    agentStep: 0,
    walkthrough: null,
    companion: { open: false, minimized: false, quiet: false, mood: "idle", topic: null, question: null },
    suggestion: null,
    offered: [],
    dismissed: [],
    suggestionsShown: 0,
    lastSuggestionAt: null,
    restored: false,
  };
}

/** May Gimbal offer this suggestion now? The rule the engagement tracker consults. */
export function canSuggest(state: LandingState, suggestion: Suggestion, now: number): boolean {
  if (state.companion.quiet || state.companion.open || state.walkthrough || state.suggestion) return false;
  if (state.offered.includes(suggestion.id) || state.dismissed.includes(suggestion.id)) return false;
  if (state.suggestionsShown >= SUGGESTION_CAP) return false;
  if (state.lastSuggestionAt !== null && now - state.lastSuggestionAt < SUGGESTION_COOLDOWN_MS) return false;
  return true;
}

const companion = (state: LandingState, patch: Partial<CompanionState>): LandingState => ({ ...state, companion: { ...state.companion, ...patch } });

export function landingReducer(state: LandingState, action: LandingAction): LandingState {
  switch (action.type) {
    case "chapter": return state.chapter === action.chapter ? state : { ...state, chapter: action.chapter };
    case "view": return state.view === action.view ? state : { ...state, view: action.view };
    case "select": return { ...state, selected: action.node };
    case "scale": return { ...state, scale: Math.max(0, Math.min(3, Math.round(action.scale))) };
    case "autonomy": return { ...state, autonomy: action.level };
    case "agent-step": return { ...state, agentStep: Math.max(0, Math.min(5, action.step)) };
    case "walkthrough-start":
      // A walkthrough is presentation: it never changes what the visitor selected.
      return { ...state, walkthrough: { id: action.id, step: 0 }, suggestion: null };
    case "walkthrough-step": return state.walkthrough ? { ...state, walkthrough: { ...state.walkthrough, step: action.step } } : state;
    case "walkthrough-end": return state.walkthrough ? { ...state, walkthrough: null } : state;
    case "companion-open":
      return companion({ ...state, suggestion: null }, { open: true, minimized: false, topic: action.topic === undefined ? state.companion.topic : action.topic, question: action.topic === undefined ? state.companion.question : null });
    case "companion-close": return companion(state, { open: false, question: null });
    case "companion-minimize": return companion(state, { minimized: action.minimized, open: action.minimized ? false : state.companion.open });
    case "companion-quiet": return companion(action.quiet ? { ...state, suggestion: null } : state, { quiet: action.quiet });
    case "companion-topic": return companion(state, { topic: action.topic, question: action.question ?? null });
    case "mood": return state.companion.mood === action.mood ? state : companion(state, { mood: action.mood });
    case "suggest":
      if (!canSuggest(state, action.suggestion, action.now)) return state;
      return { ...state, suggestion: action.suggestion, offered: [...state.offered, action.suggestion.id], suggestionsShown: state.suggestionsShown + 1, lastSuggestionAt: action.now };
    case "suggestion-dismiss":
      return state.suggestion ? { ...state, dismissed: [...state.dismissed, state.suggestion.id], suggestion: null } : state;
    case "suggestion-expire": return state.suggestion ? { ...state, suggestion: null } : state;
    case "suggestion-accept":
      return state.suggestion ? { ...state, walkthrough: { id: state.suggestion.walkthrough, step: 0 }, suggestion: null } : state;
    case "restore":
      return { ...state, restored: true, offered: action.offered, dismissed: action.dismissed, suggestionsShown: action.suggestionsShown, companion: { ...state.companion, quiet: action.quiet } };
  }
}
