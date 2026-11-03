"use client";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cx } from "@/lib/format";
import type { OAuthProvider } from "@/lib/supabase/env";
import { GoogleMark } from "./google-mark";
import { GithubMark } from "./github-mark";
import styles from "./oauth-button.module.css";

interface OAuthButtonProps extends ButtonProps {
  provider: OAuthProvider;
}

/** Shared provider treatment for sign-in, sign-up, and account linking. */
export function OAuthButton({
  provider,
  busy = false,
  disabled = false,
  disabledReason,
  className,
  children,
  icon,
  title,
  ...props
}: OAuthButtonProps) {
  if (provider !== "google") {
    return (
      <>
      <Button
        {...props}
        className={cx(styles.provider, styles.github, className)}
        busy={busy}
        disabled={disabled}
        disabledReason={busy ? "Opening GitHub…" : disabledReason}
        icon={icon ?? <GithubMark />}
        title={busy ? "Opening GitHub…" : title}
      >
        {children}
      </Button>
      <span className="sr-only" role="status">{busy ? "Opening GitHub…" : ""}</span>
      </>
    );
  }

  return (
    <>
      <Button
        {...props}
        className={cx(styles.provider, styles.google, className)}
        busy={busy}
        disabled={disabled}
        disabledReason={busy ? "Opening Google…" : disabledReason}
        data-pending={busy || undefined}
        icon={<GoogleMark />}
        title={busy ? "Opening Google…" : title}
      >
        {children}
        <span className={styles.colors} aria-hidden="true">
          <span /><span /><span /><span />
        </span>
      </Button>
      <span className="sr-only" role="status">{busy ? "Opening Google…" : ""}</span>
    </>
  );
}
