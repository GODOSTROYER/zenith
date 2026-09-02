import { Suspense } from "react";
import { blueprints } from "@/lib/blueprints";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { OnboardingFlow, type BlueprintCard } from "@/components/screens/onboarding-flow";
import { SAMPLE_COMPOSE } from "./sample-compose";

/**
 * Server half of onboarding: blueprint costs are computed here so the browser
 * never ships a pricing table. The sample compose file is a module rather than
 * an fs read — a read from process.cwd() is not traced into a standalone build
 * and used to degrade, silently, to an empty box.
 */
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
      <OnboardingFlow blueprints={cards} sampleCompose={SAMPLE_COMPOSE} />
    </Suspense>
  );
}
