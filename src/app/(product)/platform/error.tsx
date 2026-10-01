"use client";
/** Unknown errors stay generic; the retry reruns the server loader. */
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
export default function PlatformError({ reset }: { reset: () => void }) {
  return <Callout tone="err" title="Could not load platform"><p>Platform data is unavailable. Retry once the services are restored.</p><Button onClick={reset}>Retry</Button></Callout>;
}
