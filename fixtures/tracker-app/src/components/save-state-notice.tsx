/**
 * One place that turns a refusal into words. Every screen that writes shows
 * the same sentence for the same state, and none of them invents an
 * explanation the host did not give.
 *
 * `conflict` is deliberately absent: it needs the two versions side by side,
 * so the drawer renders it itself.
 */
import { SIGN_IN_PATH } from "../api";
import type { LoadState, SaveState } from "../state";
import { Notice } from "./notice";

function ReturnLink() {
  return (
    <p>
      <a className="link" href={SIGN_IN_PATH}>
        Open this app from Zenith
      </a>{" "}
      to start again.
    </p>
  );
}

export function SaveStateNotice({
  state,
  what,
  mode = "save",
  onRetry,
}: {
  state: SaveState | LoadState;
  what: string;
  /** a failed read and a failed write need different words for the same code */
  mode?: "save" | "read";
  onRetry?: () => void;
}) {
  const retry = onRetry ? (
    <button type="button" className="button" onClick={onRetry}>
      Try again
    </button>
  ) : null;

  switch (state.kind) {
    case "denied":
      return state.reason === "view_only" ? (
        <Notice tone="warn" title="Your access is view-only" live>
          <p>
            You can read every {what}. Ask whoever shared this app with you if you need to
            change them.
          </p>
        </Notice>
      ) : (
        <Notice tone="bad" title="Your access to this app was removed" live>
          <p>Nothing you had open was saved. Your changes are still on screen.</p>
          <ReturnLink />
        </Notice>
      );

    case "signed_out":
      return (
        <Notice tone="warn" title="You are signed out" live>
          <p>This app does not hold a password. Sessions come from Zenith and this one ended.</p>
          <ReturnLink />
        </Notice>
      );

    case "unavailable":
      return (
        <Notice
          tone="warn"
          title={
            mode === "read"
              ? "The host is not answering"
              : "Not saved - the host is not answering"
          }
          live
          actions={retry}
        >
          <p>{state.message}</p>
          {state.fix ? <p className="notice-fix">{state.fix}</p> : null}
          {mode === "save" ? (
            <p>Your text is still here. Trying again sends exactly what you see.</p>
          ) : (
            <p>Nothing is lost. The requests are kept by the host, not by this page.</p>
          )}
        </Notice>
      );

    case "unsupported":
      return (
        <Notice
          tone="bad"
          title={mode === "read" ? "This app cannot read what the host sent" : "That did not go through"}
          live
          actions={retry}
        >
          <p>{state.message}</p>
          {state.fix ? <p className="notice-fix">{state.fix}</p> : null}
        </Notice>
      );

    default:
      return null;
  }
}
