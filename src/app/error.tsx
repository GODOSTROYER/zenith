"use client";
/**
 * Route-level error boundary. Next's stock page shows a digest and nothing to
 * do with it; this one says what is safe (your system definition is on the
 * server), what to press, and where to look if pressing it does not help.
 */
import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { Button, Card } from "@/components/ui";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[orrery/ui] route error", error);
  }, [error]);

  return (
    <div className="animate-enter grid min-h-[60vh] place-items-center p-8">
      <Card className="w-full max-w-[560px]" title="This screen could not be rendered">
        <p className="text-[13px] text-ink-mute">
          Nothing was lost. Your system definition, revisions and deployments live on the
          server — this is a rendering failure in the browser, not a change to anything.
        </p>
        <p className="mt-2 text-[13px] text-ink-mute">
          Try again first. If it keeps happening, the deployment that was running is still
          on the Deploys tab with its full log, and every action ever taken is on Activity.
        </p>
        <pre className="mt-3 max-h-40 overflow-auto rounded-ctl border border-line bg-bg1 p-3 font-mono text-[12px] text-ink-mute">
          {error.message || String(error)}
          {error.digest ? `\n\nServer reference: ${error.digest}` : ""}
        </pre>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
            onClick={reset}
          >
            Try this screen again
          </Button>
          <Button variant="quiet" onClick={() => window.location.reload()}>
            Reload from the server
          </Button>
          <Button variant="ghost" onClick={() => window.location.assign("/overview")}>
            Go to the workspace overview
          </Button>
        </div>
      </Card>
    </div>
  );
}
