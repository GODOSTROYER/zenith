"use client";

import type { ReactNode } from "react";
import { Drawer } from "@/components/ui/drawer";

export interface ConnectedDetailProps {
  open: boolean;
  onClose: () => void;
  title: string;
  resourceId?: string;
  environment?: string;
  context?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

/** A shared, read-only identity frame. The caller owns the selected record. */
export function ConnectedDetail({ open, onClose, title, resourceId, environment, context, children, footer }: ConnectedDetailProps) {
  return (
    <Drawer open={open} onClose={onClose} title={title} width={520} footer={footer}>
      {(resourceId || environment || context) && (
        <div className="mb-6 space-y-3 border-b border-line pb-5">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-5 gap-y-2 text-[12px]">
            {resourceId && <><dt className="text-ink-mute">Resource ID</dt><dd className="break-all font-mono text-ink">{resourceId}</dd></>}
            {environment && <><dt className="text-ink-mute">Environment</dt><dd className="break-words text-ink">{environment}</dd></>}
          </dl>
          {context && <div className="text-[13px] leading-relaxed text-ink-mute">{context}</div>}
        </div>
      )}
      {children}
    </Drawer>
  );
}
