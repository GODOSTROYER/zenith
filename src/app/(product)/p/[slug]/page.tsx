import type { Metadata } from "next";
import { SystemMap } from "@/components/map/system-map";
import type { BlueprintCard } from "@/components/map/dialogs";
import { blueprints } from "@/lib/blueprints";

export const metadata: Metadata = { title: "System" };

/**
 * The System Map. Rendered on the server only to hand the blueprint catalog
 * to the client — everything else the map shows comes from the API, so the
 * map can never disagree with the rest of the product.
 */
export default function SystemMapPage() {
  const cards: BlueprintCard[] = blueprints.map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    icon: b.icon,
    highlights: b.highlights,
  }));
  return <SystemMap blueprints={cards} />;
}
