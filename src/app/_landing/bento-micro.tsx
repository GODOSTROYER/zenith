"use client";

import { useEffect, type ComponentPropsWithoutRef, type RefObject } from "react";
import { installBentoMicro } from "./bento-micro-runtime";

export function useBentoMicro(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (root.current) return installBentoMicro(root.current);
  }, [root]);
}

/** Keeps real native buttons and pressed state; the sliding highlight is purely visual. */
export function MicroGroup({ tone, children, ...props }: ComponentPropsWithoutRef<"div"> & { tone: "view" | "autonomy" | "team" | "estimate" }) {
  return <div {...props} data-micro-group={tone}>
    <span data-micro-pill aria-hidden="true" />
    {children}
  </div>;
}
