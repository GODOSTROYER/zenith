/** Platform navigation lives inside the existing product shell, which supplies the one main landmark. */
import type { ReactNode } from "react";
import { PlatformNav } from "./_components/platform-nav";
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return <div className="product-page mx-auto h-full max-w-[1320px] overflow-y-auto">
    <PlatformNav />
    {children}
  </div>;
}
