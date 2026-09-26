"use client";
/** Connected sign-in methods. Linking begins on the server so its callback can verify this account. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { UserIdentity } from "@supabase/supabase-js";
import { Link2, Unlink } from "lucide-react";
import { api, ApiError } from "@/lib/client/api";
import { createClient } from "@/lib/supabase/client";
import {
  OAUTH_PROVIDER_LABEL,
  SUPABASE_OAUTH_PROVIDERS,
  type OAuthProvider,
} from "@/lib/supabase/env";
import { explain } from "@/components/auth/messages";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { NoteLine, type Note } from "./account-profile";

export type AccountIdentity = UserIdentity & { email?: string };

export const LINKING_DISABLED =
  "Identity linking is not enabled for this deployment. Ask an operator to enable manual identity linking in Supabase authentication settings, then try connecting again.";

export function isLinkingDisabled(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code === "manual_linking_disabled") return true;
  const message = typeof e?.message === "string" ? e.message.toLowerCase() : "";
  return message.includes("manual linking") || message.includes("linking is disabled");
}

const LINK_ERRORS: Record<string, string> = {
  identity_link_failed:
    "The provider could not be connected. Try connecting again from this page.",
  identity_link_expired:
    "That connection attempt expired. Start again from this page and finish in this browser.",
  identity_link_conflict:
    "That provider account is already connected to another account. Choose a different provider account, or sign in to the account it already belongs to.",
  identity_link_cancelled:
    "The provider connection was cancelled. Try again when you are ready to approve it.",
  identity_link_mismatch:
    "Your sign-in session changed before the connection finished. Sign in to the original account and check its connected methods before trying again.",
};

const providerLabel = (provider: string): string =>
  provider === "email" ? "Email" : (OAUTH_PROVIDER_LABEL[provider as OAuthProvider] ?? provider);

function identityEmail(identity: AccountIdentity): string | undefined {
  const metadataEmail: unknown = identity.identity_data?.email;
  const email: unknown = typeof metadataEmail === "string" ? metadataEmail : identity.email;
  return typeof email === "string" ? email : undefined;
}

function failureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.fix ? `${error.message} ${error.fix}` : error.message;
  }
  if (isLinkingDisabled(error)) return LINKING_DISABLED;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string"
    ? explain(message)
    : "The request could not be completed. Try again in a moment.";
}

export function IdentitiesCard() {
  const [identities, setIdentities] = useState<AccountIdentity[]>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [note, setNote] = useState<Note>();
  const [busy, setBusy] = useState<string>();
  const [removing, setRemoving] = useState<AccountIdentity>();
  // Lock immediately: another provider must not replace the pending OAuth verifier.
  const mutating = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const { data, error } = await createClient().auth.getUserIdentities();
      if (error) throw error;
      setIdentities((data?.identities ?? []) as AccountIdentity[]);
    } catch {
      setIdentities(undefined);
      setLoadError("Could not load your sign-in methods. Try again; if this continues, sign out and sign in again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Read after hydration; account pages do not need a search-param Suspense boundary.
    const params = new URLSearchParams(window.location.search);
    const error = params.get("identity_error");
    if (error) {
      setNote({
        kind: "err",
        text: Object.hasOwn(LINK_ERRORS, error) ? LINK_ERRORS[error] : LINK_ERRORS.identity_link_failed,
      });
    } else if (params.get("identity") === "linked") {
      setNote({ kind: "ok", text: "The provider is connected. You can use it to sign in to this same account." });
    }
    void load();
  }, [load]);

  const disabled = loading || !identities || Boolean(busy);
  const disabledReason = loading
    ? "Wait for your sign-in methods to load."
    : !identities
      ? "Reload your sign-in methods before making changes."
      : "Wait for the current sign-in change to finish.";

  const link = async (provider: OAuthProvider) => {
    if (disabled || mutating.current) return;
    mutating.current = true;
    setBusy(provider);
    setNote(undefined);
    try {
      const { url } = await api<{ url: string }>("/api/account/identities/link", {
        method: "POST",
        body: JSON.stringify({ provider }),
      });
      window.location.assign(url);
      // Keep every action locked while the browser navigates to the provider.
    } catch (error) {
      setNote({ kind: "err", text: failureMessage(error) });
      mutating.current = false;
      setBusy(undefined);
    }
  };

  const unlink = async (identity: AccountIdentity) => {
    if (disabled || mutating.current || identity.provider === "email" || identities.length <= 1) return;
    mutating.current = true;
    setBusy(identity.identity_id);
    setNote(undefined);
    try {
      const { error } = await createClient().auth.unlinkIdentity(identity);
      if (error) throw error;
      setRemoving(undefined);
      setNote({ kind: "ok", text: `${providerLabel(identity.provider)} was removed from your sign-in methods.` });
      await load();
    } catch (error) {
      setNote({ kind: "err", text: failureMessage(error) });
    } finally {
      mutating.current = false;
      setBusy(undefined);
    }
  };

  const closeRemoval = () => {
    if (mutating.current) return;
    setRemoving(undefined);
    setNote(undefined);
  };
  const linked = new Set((identities ?? []).map((identity) => identity.provider));
  const linkable = SUPABASE_OAUTH_PROVIDERS.filter((provider) => !linked.has(provider));
  const last = (identities?.length ?? 0) <= 1;

  return (
    <>
      <Card
        title="Ways to sign in"
        subtitle="Connect a provider to use it with this same account. Email and your last connected method cannot be removed here."
        padded={false}
      >
        {loading && !identities ? (
          <div className="p-5" role="status" aria-label="Loading sign-in methods">
            <Skeleton height={64} />
          </div>
        ) : loadError ? (
          <div className="px-5 pb-4">
            <NoteLine note={{ kind: "err", text: loadError }} />
            <Button size="sm" className="mt-3" onClick={() => { setNote(undefined); void load(); }}>
              Retry loading sign-in methods
            </Button>
          </div>
        ) : identities?.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-ink-mute">
            No sign-in methods came back for this account. Sign out and sign in again to refresh your session.
          </p>
        ) : (
          <ul>
            {identities?.map((identity) => {
              const email = identityEmail(identity);
              const protectedEmail = identity.provider === "email";
              return (
                <li key={identity.identity_id} className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-ink">{providerLabel(identity.provider)}</p>
                    {email && <p className="break-all font-mono text-[12px] text-ink-mute">{email}</p>}
                  </div>
                  {last && <Chip tone="neutral">only way in</Chip>}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Unlink className="h-3.5 w-3.5" />}
                    busy={busy === identity.identity_id}
                    disabled={disabled || protectedEmail || last}
                    disabledReason={protectedEmail
                      ? "Email cannot be removed as a sign-in method."
                      : last
                        ? "This is your only sign-in method. Connect another one before removing it."
                        : disabledReason}
                    onClick={() => { setNote(undefined); setRemoving(identity); }}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {linkable.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3.5">
            {linkable.map((provider) => (
              <Button
                key={provider}
                size="sm"
                icon={<Link2 className="h-3.5 w-3.5" />}
                busy={busy === provider}
                disabled={disabled}
                disabledReason={disabledReason}
                onClick={() => void link(provider)}
              >
                Connect {OAUTH_PROVIDER_LABEL[provider]}
              </Button>
            ))}
          </div>
        )}
        {note && !removing && <div className="border-t border-line px-5 pt-1 pb-4"><NoteLine note={note} /></div>}
      </Card>
      <Dialog
        open={Boolean(removing)}
        onClose={closeRemoval}
        title={`Remove ${removing ? providerLabel(removing.provider) : "provider"}?`}
        description="You will need another connected method to sign in. Make sure you can use it before removing this one."
        footer={
          <>
            <Button onClick={closeRemoval} disabled={Boolean(busy)} disabledReason={disabledReason}>Cancel</Button>
            <Button
              variant="danger"
              busy={Boolean(busy)}
              disabled={disabled}
              disabledReason={disabledReason}
              onClick={() => { if (removing) void unlink(removing); }}
            >
              Remove sign-in method
            </Button>
          </>
        }
      >
        {note && <NoteLine note={note} />}
      </Dialog>
    </>
  );
}
