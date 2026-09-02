import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthForm, AuthFormSkeleton } from "@/components/auth/auth-form";

export const metadata: Metadata = { title: "New password" };
export const dynamic = "force-dynamic";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthFormSkeleton />}>
      <AuthForm mode="reset" />
    </Suspense>
  );
}
