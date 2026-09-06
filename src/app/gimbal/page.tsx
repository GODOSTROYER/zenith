import type { Metadata } from "next";
import { GimbalPreview } from "@/components/navigator/gimbal-preview";

export const metadata: Metadata = {
  title: "Gimbal character review",
  description: "Review Navigator's five character states, motion settings and production assets.",
  robots: { index: false, follow: false },
};

export default function GimbalPage() {
  return <GimbalPreview />;
}
