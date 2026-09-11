import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { Cta } from "./cta";

export function LandingCta({ cta, className = "" }: { cta: Cta; className?: string }) {
  return <Link href={cta.href} className={`zenith-cta ${className}`} data-zenith-cta>{cta.label}<ArrowUpRight size={18} aria-hidden="true" /></Link>;
}
