import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthForm, AuthFormSkeleton } from "@/components/auth/auth-form";

export const metadata: Metadata = { title: "Reset password" };
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<AuthFormSkeleton />}>
      <AuthForm mode="forgot" />
    </Suspense>
  );
}
