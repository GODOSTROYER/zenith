/** Platform navigation lives inside the existing product shell, which supplies the one main landmark. */
import type { ReactNode } from "react";
import { PlatformNav } from "./_components/platform-nav";
import Link from "next/link";
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return <div className="product-page mx-auto h-full max-w-[1320px] overflow-y-auto">
    <PlatformNav />
    <p className="mb-4 text-sm">Privileged actions require authenticator verification. <Link href="/account/mfa/challenge" className="text-signal underline">Verify your authenticator</Link>.</p>
    {children}
  </div>;
}
