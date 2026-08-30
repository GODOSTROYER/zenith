import type { Metadata } from "next";
import { NavigatorScreen } from "@/components/navigator/navigator-screen";
import { plannerMode } from "@/lib/navigator/llm";

export const metadata: Metadata = { title: "Navigator" };
export const dynamic = "force-dynamic";

export default async function NavigatorPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <NavigatorScreen slug={slug} plannerMode={plannerMode()} />;
}
