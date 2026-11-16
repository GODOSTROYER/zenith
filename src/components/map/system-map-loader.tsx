"use client";

import dynamic from "next/dynamic";
import { ScreenLoading } from "@/components/shell/screen-loading";
import type { SystemMapProps } from "./system-map";

// React Flow uses browser measurements. Rendering it on the server cannot
// produce the graph, but used to compile the graph and all editors twice.
const Map = dynamic(() => import("./system-map").then((m) => m.SystemMap), {
  ssr: false,
  loading: () => <ScreenLoading label="system map" variant="canvas" />,
});

export function SystemMapLoader(props: SystemMapProps) {
  return <Map {...props} />;
}
