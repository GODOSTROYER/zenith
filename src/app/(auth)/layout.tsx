import type { ReactNode } from "react";
import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { AuthShell } from "@/components/auth/auth-shell";

/** The sign-in world: no product chrome, one centered panel, honest status. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <AuthShell configured={isSupabaseConfigured()}>
      {children}
      <p className="mt-8 text-center text-[12.5px] text-ink-faint">
        <Link href="/" className="transition-colors hover:text-ink">
          ← Back to the front page
        </Link>
      </p>
    </AuthShell>
  );
}
