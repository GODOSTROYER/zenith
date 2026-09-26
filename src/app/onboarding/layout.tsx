import type { Metadata } from "next";
import { ToastProvider } from "@/components/ui/toast";
import { requireProductPageAccess } from "@/lib/waitlist/enforcement";

export const metadata: Metadata = { title: "Get started" };

/**
 * Onboarding runs outside the product shell — no project chrome, nothing to
 * navigate away to yet. It brings its own toast host.
 */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  await requireProductPageAccess();
  return (
    <ToastProvider>
      <div className="min-h-screen bg-bg0">{children}</div>
    </ToastProvider>
  );
}
