"use client";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";

interface Props {
  /** what broke, in the user's words: "the source editor" */
  what?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps one broken screen from taking the whole app with it. The recovery
 * control reloads the route, which re-reads the server's copy of the project —
 * the last state everyone agrees on.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[zenith/ui] screen crashed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const what = this.props.what ?? "this screen";

    return (
      <div className="animate-enter grid place-items-center p-8">
        <Callout
          tone="err"
          className="w-full max-w-[560px]"
          title={<h2 className="text-[15px] font-medium text-ink">{what} stopped rendering</h2>}
          actions={
            <>
              <Button
                variant="primary"
                icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
                onClick={() => window.location.reload()}
              >
                Restore from the server
              </Button>
              <Button variant="quiet" onClick={() => this.setState({ error: null })}>
                Try rendering again
              </Button>
            </>
          }
        >
          <p className="text-[13px] text-ink-mute">
            Nothing was lost. Your system definition lives on the server, not in this
            panel — restoring reloads it from there.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto rounded-ctl border border-line bg-bg1 p-3 font-mono text-[12px] text-ink-mute">
            {error.message || String(error)}
          </pre>
        </Callout>
      </div>
    );
  }
}
