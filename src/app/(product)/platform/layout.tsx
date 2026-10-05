/** Platform navigation lives inside the existing product shell. */
import Link from "next/link";
import type { ReactNode } from "react";
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return <div className="product-page mx-auto h-full max-w-[1320px] overflow-y-auto">
    <nav aria-label="Platform navigation" className="mb-6 flex flex-wrap gap-5 border-b border-line pb-4 text-[13px] text-signal">
      <Link href="/platform">Operations</Link><Link href="/platform/environments">Environments</Link>
      <Link href="/platform/settings">Workspace policy</Link><Link href="/platform/connections/aws">Connect AWS</Link>
      <Link href="/api/platform/v1/github/callback">GitHub source</Link>
      <Link href="/platform/runners">Runners</Link>
    </nav>{children}
  </div>;
}
