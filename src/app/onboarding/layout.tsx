import type { Metadata } from "next";
import { ToastProvider } from "@/components/ui/toast";

export const metadata: Metadata = { title: "Get started" };

/**
 * Onboarding runs outside the product shell — no project chrome, nothing to
 * navigate away to yet. It brings its own toast host.
 */
export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="min-h-screen bg-bg0">{children}</div>
    </ToastProvider>
  );
}
