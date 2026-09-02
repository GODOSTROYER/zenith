"use client";
/**
 * Editors get a boundary: a crash in the source editor must never take the
 * app down, and recovery is one button that restores the last good text.
 */
import { Component, type ReactNode } from "react";
import { Button, Callout } from "@/components/ui";

interface Props {
  children: ReactNode;
  /** called when the operator asks for the last good state back */
  onRestore: () => void;
}

interface State {
  error: Error | null;
}

export class EditorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Callout
        tone="err"
        title={<h3 className="text-[15px] font-medium text-ink">The editor stopped rendering.</h3>}
        actions={
          <Button
            onClick={() => {
              this.props.onRestore();
              this.setState({ error: null });
            }}
          >
            Restore last good text
          </Button>
        }
      >
        <p className="max-w-[60ch] text-[13px] text-ink-mute">
          Nothing was saved and the system is untouched. Restore the last good text to carry on.
        </p>
        <p className="mt-3 font-mono text-[12px] text-ink-faint">{this.state.error.message}</p>
      </Callout>
    );
  }
}
