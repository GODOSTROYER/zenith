import type { Metadata } from "next";
import { NavigatorScreen } from "@/components/navigator/navigator-screen";
import { plannerMode, plannerModel } from "@/lib/navigator/config";

export const metadata: Metadata = { title: "Navigator" };
export const dynamic = "force-dynamic";

export default async function NavigatorPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <NavigatorScreen slug={slug} plannerMode={plannerMode()} plannerModel={plannerModel()} />;
}
