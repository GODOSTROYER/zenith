/** Presentation-only helpers. No workspace, provider or action APIs belong here. */
import type { ProviderRow } from "./landing";

export function planRiskLabel(items: ReadonlyArray<{ risk: string }>): string {
  if (!items.length) return "No changes";
  return items.every((item) => item.risk === "low") ? "Low risk" : "Review risk in the plan";
}

/** The registry controls availability. A provider's name never implies support. */
export function providerPresentation(provider: ProviderRow) {
  if (provider.availability === "planned") {
    return { tone: "planned", label: "Planned", description: provider.tagline } as const;
  }
  if (provider.availability === "preview") {
    return {
      tone: "preview", label: "Preview",
      description: provider.id === "aws"
        ? "Plans and Terraform export. No AWS API calls or in-app deployment."
        : provider.tagline,
    } as const;
  }
  if (provider.id === "sandbox") {
    return { tone: "simulated", label: "Available · simulated", description: "Practice safely. No cloud resources are created." } as const;
  }
  if (provider.id === "localstack") {
    return { tone: "available", label: "Available · local", description: "Real local storage and queue operations. Other operations remain simulated." } as const;
  }
  return { tone: "available", label: "Available", description: provider.tagline } as const;
}

export const EXPORT_ARTIFACTS = [
  { name: "System", file: "zenith.manifest.json", description: "Your complete system definition, ready to take with you." },
  { name: "Terraform", file: "Terraform / *.tf", description: "Real Terraform for AWS, to review and run with your own tools." },
  { name: "Operations", file: "Operations / README.md", description: "Operating notes that travel with your system." },
] as const;

export const TEAM_STORIES = [
  { name: "Solo", situation: "Your product grew. Your team is still you.", outcome: "See what runs underneath it, without becoming a platform team." },
  { name: "Small team", situation: "Three people. One system to understand.", outcome: "Give everyone the same picture of what exists and what changes next." },
  { name: "AI-native", situation: "Your agent is ready to change more than code.", outcome: "Review its plan without giving it an invisible path to execution." },
] as const;
