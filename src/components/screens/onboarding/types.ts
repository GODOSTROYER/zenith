/**
 * The shapes the three onboarding steps hand each other, and the step list the
 * rail and the header both read. No component here — see step-*.tsx.
 */
import type { CloudConnection, Workspace } from "@/lib/domain/types";

export interface BlueprintCard {
  id: string;
  name: string;
  description: string;
  highlights: string[];
  nodes: number;
  services: number;
  resources: number;
  monthlyUsd: number;
}

export interface ProviderInfo {
  id: string;
  displayName: string;
  availability: "available" | "preview" | "planned";
  tagline: string;
  regions: { id: string; label: string }[];
}

/** GET /api/bootstrap */
export interface Bootstrap {
  workspace: Workspace;
  connections: CloudConnection[];
  providers: ProviderInfo[];
}

/** What step 2 settled on. Nothing is created there — this is a choice, not a record. */
export interface ProviderChoice {
  providerId: string;
  /** an existing connection for that provider, when the workspace already has one */
  connectionId?: string;
  displayName: string;
}

export const STEPS = [
  { n: 1, title: "Name your workspace", hint: "Where your projects live" },
  { n: 2, title: "Where will you run?", hint: "Provider and exact access" },
  { n: 3, title: "Start your system", hint: "Blueprint, import, or blank" },
] as const;
