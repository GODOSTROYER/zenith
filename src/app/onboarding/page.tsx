import fs from "node:fs";
import path from "node:path";
import { Suspense } from "react";
import { blueprints } from "@/lib/blueprints";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { OnboardingFlow, type BlueprintCard } from "@/components/screens/onboarding-flow";

/**
 * Server half of onboarding: blueprint costs and the sample compose file are
 * computed here so the browser never ships a pricing table or a fixture reader.
 */
function sampleCompose(): string {
  try {
    return fs.readFileSync(
      path.join(process.cwd(), "fixtures", "sample-app", "docker-compose.yml"),
      "utf8"
    );
  } catch {
    return "";
  }
}

export default function OnboardingPage() {
  const cards: BlueprintCard[] = blueprints.map((b) => {
    const manifest = b.manifestFactory("demo");
    return {
      id: b.id,
      name: b.name,
      description: b.description,
      highlights: b.highlights,
      nodes:
        manifest.services.length + manifest.resources.length + manifest.routes.length,
      services: manifest.services.length,
      resources: manifest.resources.length,
      monthlyUsd: monthlyCostUsd(manifest),
    };
  });

  return (
    <Suspense fallback={null}>
      <OnboardingFlow blueprints={cards} sampleCompose={sampleCompose()} />
    </Suspense>
  );
}
