import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthForm, AuthFormSkeleton } from "@/components/auth/auth-form";
import { SignupWaitlistNotice } from "@/components/auth/signup-waitlist-notice";
import { waitlistGateEnabled } from "@/lib/waitlist/config";

export function generateMetadata(): Metadata {
  return { title: waitlistGateEnabled() ? "Join the waitlist" : "Create account" };
}
export const dynamic = "force-dynamic";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  if (waitlistGateEnabled()) {
    const { next } = await searchParams;
    return <SignupWaitlistNotice next={typeof next === "string" ? next : undefined} />;
  }
  return (
    <Suspense fallback={<AuthFormSkeleton />}>
      <AuthForm mode="signup" />
    </Suspense>
  );
}
