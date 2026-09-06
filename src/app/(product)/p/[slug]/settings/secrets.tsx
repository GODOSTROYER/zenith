"use client";
/**
 * Secrets — what the store holds, and the two things you can do to a value you
 * cannot see.
 *
 * The list is metadata only: the reference, the version it is on, when it last
 * changed and who changed it. No route returns a plaintext value and nothing
 * here asks for one, so a value never appears on this screen even for an admin.
 *
 * Rotate writes a new value under the same reference — the manifest holds the
 * reference, so nothing is diffed, revisioned or exported by rotating. Remove
 * is not offered here at all: `system.removeSecret` takes a service and a key
 * because it removes the reference from the manifest too, and the place that
 * knows both is the service on the map.
 */
import { useState } from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import type { Role } from "@/lib/actions/core";
import type { Manifest } from "@/lib/domain/types";
import { isOurs, useSecrets } from "@/lib/client/secrets";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TimeAgo } from "@/components/ui/time-ago";
import { ActionConfirm, ErrorNote } from "@/components/screens/shared";
import { useGate } from "./access";

const REDEPLOY_NOTE =
  "Services already running keep the copy they were given at deploy time. They pick a new value up on the next deploy, not now.";

/** The service and variable a reference is wired to, when one in this project is. */
function referencedBy(manifest: Manifest, ref: string): { id: string; name: string; key: string } | undefined {
  for (const s of manifest.services) {
    const entry = s.env.find((e) => e.secretRef === ref);
    if (entry) return { id: s.id, name: s.name, key: entry.key };
  }
  return undefined;
}

export function SecretsSection({
  workspaceId,
  workspaceName,
  projectId,
  slug,
  manifest,
  role,
}: {
  workspaceId: string;
  workspaceName: string;
  projectId: string | undefined;
  slug: string;
  /** the working copy — which service a reference is wired to is read from it */
  manifest: Manifest;
  role: Role | null | undefined;
}) {
  const gate = useGate();
  const { store, error, refresh } = useSecrets(workspaceId);
  /** which row's rotate form is open, and the value typed into it */
  const [openRef, setOpenRef] = useState<string | null>(null);
  const [value, setValue] = useState("");
  /**
   * Captured when the preview is asked for, so the dialog plans once against a
   * fixed input. Typing into `value` must never re-plan: that would send the
   * new secret to the server on every keystroke.
   */
  const [pending, setPending] = useState<{ ref: string; value: string } | null>(null);

  const rotateGate = gate(role, "system.rotateSecret");

  const close = () => {
    setOpenRef(null);
    setValue("");
  };

  if (error) return <ErrorNote error={error} />;
  if (!store) return <Skeleton height={180} />;

  // Not an error: nothing is broken, there is simply nowhere to put a value.
  // An empty list here would read as "no secrets yet", which is a lie.
  if (!store.configured)
    return (
      <Callout tone="warn">
        <p>
          {store.reason} {store.fix}
        </p>
        <p className="mt-1 text-ink-mute">
          Until then a service can still name a reference to a value you keep elsewhere, and your
          provider resolves it at deploy time.
        </p>
      </Callout>
    );

  return (
    <>
      <Card
        title={`${store.secrets.length} stored value${store.secrets.length === 1 ? "" : "s"}`}
        subtitle={`Encrypted under this server's ORRERY_SECRET_KEY. Only the reference reaches a manifest, a diff, the audit log or an export — never the value, and there is no route that returns one.`}
        padded={false}
      >
        {store.secrets.length === 0 ? (
          <p className="max-w-[80ch] px-5 py-4 text-[13px] text-ink-mute">
            The store is configured and holds nothing yet in {workspaceName}. A value lands here
            the first time a service variable is stored as a secret — open a service on the map and
            use Set secret on the variable.
          </p>
        ) : (
          <ul>
            {store.secrets.map((s) => {
              const ours = isOurs(s.ref);
              const wired = referencedBy(manifest, s.ref);
              const open = openRef === s.ref;
              const rotateWhy =
                rotateGate ??
                (ours
                  ? undefined
                  : `${s.ref} is not held by Zenith.ai — it names a value in your own secret manager, which Zenith.ai cannot write to. Rotate it there, then redeploy so the services pick it up.`);

              return (
                <li key={s.ref} className="border-b border-line px-5 py-3.5 last:border-b-0">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2">
                        <KeyRound className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
                        <span className="break-all font-mono text-[12.5px] text-ink">{s.ref}</span>
                        <span className="tnum shrink-0 font-mono text-[12px] text-ink-mute">
                          v{s.version}
                        </span>
                      </p>
                      <p className="mt-0.5 text-[12px] text-ink-faint">
                        created by {s.createdBy} <TimeAgo iso={s.createdAt} />
                        {wired ? (
                          <>
                            {" · "}
                            <span className="font-mono">{wired.key}</span> on {wired.name}
                          </>
                        ) : (
                          " · no service in this project references it"
                        )}
                      </p>
                    </div>

                    <span className="shrink-0 text-[12px] text-ink-mute">
                      <TimeAgo iso={s.updatedAt} prefix="updated" /> by {s.updatedBy}
                    </span>

                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="quiet"
                        disabled={Boolean(rotateWhy)}
                        disabledReason={rotateWhy}
                        onClick={() => {
                          if (open) return close();
                          setOpenRef(s.ref);
                          setValue("");
                        }}
                      >
                        {open ? "Cancel" : "Rotate"}
                      </Button>
                      {/* Removing takes the reference out of the manifest too,
                          so it needs the service and the key — which is the
                          service's own panel, not a row in a list. */}
                      {wired ? (
                        <Link
                          href={`/p/${slug}?select=${wired.id}`}
                          title={`Removing a secret takes ${wired.key} off ${wired.name} as well as the stored value, so it is done on the service.`}
                          className="text-[12.5px] text-signal underline-offset-2 hover:underline"
                        >
                          Remove on {wired.name} →
                        </Link>
                      ) : (
                        <span
                          className="text-[12.5px] text-ink-faint"
                          title="Remove takes a service and a key, because it removes the reference from the manifest as well as the value. Nothing in this project's working copy points at this reference."
                        >
                          nothing to remove it from
                        </span>
                      )}
                    </div>
                  </div>

                  {open && (
                    <div className="animate-enter mt-3 max-w-[520px] border-t border-line pt-3">
                      <Field
                        label={`New value for ${s.ref}`}
                        help={`Replaces the value at ${s.ref} and takes it to v${s.version + 1}. The old value is not recoverable, and it is never shown here.`}
                      >
                        <Input
                          type="password"
                          value={value}
                          autoFocus
                          autoComplete="new-password"
                          spellCheck={false}
                          placeholder="Paste the new value"
                          onChange={(e) => setValue(e.target.value)}
                        />
                      </Field>
                      <div className="mt-3 flex items-center gap-3">
                        <Button
                          size="sm"
                          disabled={value.length === 0}
                          disabledReason="Paste the new value first — rotating to an empty value is not a rotation."
                          onClick={() => setPending({ ref: s.ref, value })}
                        >
                          Preview and rotate
                        </Button>
                        <p className="text-[12px] text-ink-faint">{REDEPLOY_NOTE}</p>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {pending && (
        <ActionConfirm
          open
          onClose={() => setPending(null)}
          actionId="system.rotateSecret"
          input={{ secretRef: pending.ref, secretValue: pending.value }}
          scope={{ projectId }}
          title={`Rotate ${pending.ref}`}
          description="The manifest does not change: it holds the reference, and this replaces what is behind it."
          confirmLabel="Rotate secret"
          onDone={() => {
            setPending(null);
            close();
            refresh();
          }}
        />
      )}
    </>
  );
}
