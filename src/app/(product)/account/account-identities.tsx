"use client";
/**
 * The ways into this account: the email and password, plus any provider you
 * have connected.
 *
 * One rule holds the screen together — you can never remove the last way in.
 * The API enforces it too, but a button that hands back "you are locked out
 * now" is not a control, so the last identity is disabled here with the reason
 * on it.
 *
 * Linking is a Supabase project setting ("manual linking"). Where it is off,
 * the call comes back with an error nobody can act on from the raw text, so
 * this says what it means in one sentence instead of quoting it.
 */
import { useCallback, useEffect, useState } from "react";
import type { UserIdentity } from "@supabase/supabase-js";
import { Link2, Unlink } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { NoteLine, type Note } from "./account-profile";

/**
 * The identity as the screen uses it. `unlinkIdentity` takes the whole record
 * back, so this is Supabase's own type with the two fields the list reads
 * narrowed to what is actually rendered — never the provider's raw metadata.
 */
export type AccountIdentity = UserIdentity & { email?: string };

export const LINKING_DISABLED =
  "Identity linking is not enabled for this deployment, so a provider cannot be connected to an existing account here. Signing in with that provider on the sign-in page uses whichever account it already belongs to.";

/** True for the "manual linking is disabled" refusal, whatever wording it arrives in. */
export function isLinkingDisabled(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e && typeof e.code === "string" && e.code === "manual_linking_disabled") return true;
  const message = typeof e?.message === "string" ? e.message.toLowerCase() : "";
  return message.includes("manual linking") || message.includes("linking is disabled");
}

/** The label for a provider, without ever title-casing a raw provider string. */
const providerLabel = (provider: string): string =>
  provider === "email"
    ? "Email and password"
    : (OAUTH_PROVIDER_LABEL[provider as OAuthProvider] ?? provider);

export function IdentitiesCard() {
  const [identities, setIdentities] = useState<AccountIdentity[]>();
  const [note, setNote] = useState<Note>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      const { data, error } = await createClient().auth.getUserIdentities();
      if (error) throw error;
      setIdentities((data?.identities ?? []) as AccountIdentity[]);
    } catch (e) {
      setIdentities([]);
      setNote({ kind: "err", text: explain(e instanceof Error ? e.message : String(e)) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const link = async (provider: OAuthProvider) => {
    setBusy(provider);
    setNote(undefined);
    try {
      const { error } = await createClient().auth.linkIdentity({
        provider,
        options: { redirectTo: `${window.location.origin}/auth/callback?next=/account` },
      });
      if (error) throw error;
      // Success navigates this tab to the provider; `busy` stays on so the
      // page does not look idle during the hop.
    } catch (e) {
      setNote({
        kind: "err",
        text: isLinkingDisabled(e)
          ? LINKING_DISABLED
          : explain(e instanceof Error ? e.message : String(e)),
      });
      setBusy(undefined);
    }
  };

  const unlink = async (identity: AccountIdentity) => {
    setBusy(identity.identity_id);
    setNote(undefined);
    try {
      const { error } = await createClient().auth.unlinkIdentity(identity);
      if (error) throw error;
      setNote({
        kind: "ok",
        text: `${providerLabel(identity.provider)} is no longer a way into this account.`,
      });
      await load();
    } catch (e) {
      setNote({
        kind: "err",
        text: isLinkingDisabled(e)
          ? LINKING_DISABLED
          : explain(e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setBusy(undefined);
    }
  };

  const linked = new Set((identities ?? []).map((i) => i.provider));
  const linkable = SUPABASE_OAUTH_PROVIDERS.filter((p) => !linked.has(p));
  const last = (identities?.length ?? 0) <= 1;

  return (
    <Card
      title="Ways to sign in"
      subtitle="Each of these opens this same account. The last one cannot be removed — that would lock you out of everything you are a member of."
      padded={false}
    >
      {!identities ? (
        <div className="p-5">
          <Skeleton height={64} />
        </div>
      ) : identities.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-ink-mute">
          No sign-in methods came back for this account. Reload the page; if it stays empty, sign
          out and in again so the session is re-read.
        </p>
      ) : (
        <ul>
          {identities.map((identity) => (
            <li
              key={identity.identity_id}
              className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">
                  {providerLabel(identity.provider)}
                </p>
                {identity.email && (
                  <p className="break-all font-mono text-[12px] text-ink-mute">{identity.email}</p>
                )}
              </div>
              {last && <Chip tone="neutral">only way in</Chip>}
              <Button
                size="sm"
                variant="ghost"
                icon={<Unlink className="h-3.5 w-3.5" />}
                busy={busy === identity.identity_id}
                disabled={last}
                disabledReason="This is the only way into your account. Connect another one first, and then this can be removed."
                onClick={() => void unlink(identity)}
              >
                Remove
              </Button>
            </li>
          ))}
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
              onClick={() => void link(provider)}
            >
              Connect {OAUTH_PROVIDER_LABEL[provider]}
            </Button>
          ))}
        </div>
      )}

      {note && (
        <div className="border-t border-line px-5 pt-1 pb-4">
          <NoteLine note={note} />
        </div>
      )}
    </Card>
  );
}
