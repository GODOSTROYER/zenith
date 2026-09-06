"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import type { SystemMapProps } from "./system-map";

// React Flow uses browser measurements. Rendering it on the server cannot
// produce the graph, but used to compile the graph and all editors twice.
const Map = dynamic(() => import("./system-map").then((m) => m.SystemMap), {
  ssr: false,
  loading: () => (
    <div role="status" aria-label="Loading system map" className="h-full space-y-4 p-6">
      <Skeleton height={32} width="55%" />
      <Skeleton height="70%" />
    </div>
  ),
});

export function SystemMapLoader(props: SystemMapProps) {
  return <Map {...props} />;
}
