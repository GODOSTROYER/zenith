/** Platform navigation lives inside the existing product shell, which supplies the one main landmark. */
import Link from "next/link";
import type { ReactNode } from "react";
import { PlatformNav } from "./_components/platform-nav";
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return <div className="product-page mx-auto h-full max-w-[1320px] overflow-y-auto">
    <PlatformNav><Link href="/api/platform/v1/github/callback">GitHub source</Link></PlatformNav>
    {children}
  </div>;
}
