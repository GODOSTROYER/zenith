/** Planner display settings, without importing the LLM client or executor. */
import { configured, env } from "@/lib/env";

export type PlannerMode = "llm" | "deterministic";
export const plannerModel = (): string => env().ORRERY_LLM_MODEL;
export const plannerMode = (): PlannerMode => configured().anthropic ? "llm" : "deterministic";
