/**
 * The shapes the three onboarding steps hand each other, and the step list the
 * rail and the header both read. No component here — see step-*.tsx.
 */
export type { Bootstrap } from "@/components/shell/shell-context";

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

/** What step 2 settled on. Nothing is created there — this is a choice, not a record. */
export interface ProviderChoice {
  providerId: string;
  /** an existing connection for that provider, when the workspace already has one */
  connectionId?: string;
  displayName: string;
}

export const STEPS = [
  { n: 1, title: "Choose your workspace", hint: "Your team and projects" },
  { n: 2, title: "Choose how to start", hint: "Local, preview, or simulation" },
  { n: 3, title: "Shape your blueprint", hint: "An editable system, not a deployment" },
  { n: 4, title: "Get oriented", hint: "Explore at your own pace" },
] as const;
