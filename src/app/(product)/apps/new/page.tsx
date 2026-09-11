"use client";
/**
 * Create an app: a name for people, and a URL name that becomes the first part
 * of its address. The address is shown while it is being typed, because it is
 * the part that cannot be changed later without changing every link.
 *
 * Workstream W9 (hosted R3)
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ErrorNote, useSafeToasts } from "@/components/screens/shared";
import { PageHeading } from "@/components/screens/page-heading";
import { useShell } from "@/components/shell/shell-context";
import { SLUG_RULE, deriveSlug, slugProblem } from "../slug";
import { createHostedApp, domainHint, useHostedApps } from "@/lib/client/hosted";

export default function NewAppPage() {
  const router = useRouter();
  const toasts = useSafeToasts();
  const { boot } = useShell();
  const { data } = useHostedApps();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const effectiveSlug = slugEdited ? slug : deriveSlug(name);
  const problem = slugProblem(effectiveSlug);
  const trimmedName = name.trim();
  const { appDomain: domain, appScheme: scheme } = domainHint(data);
  const builders = data?.builders ?? [];
  const builderBlocked = builders.length > 0 && builders.every((b) => !b.availability.available);

  const viewerOnly = boot?.role === "viewer";
  const createReason = viewerOnly
    ? `Creating an app needs the editor role in ${boot?.workspace.name ?? "this workspace"} and you are viewer. Ask a workspace admin to raise your role in Settings → Members.`
    : !trimmedName
      ? "Give the app a name first."
      : problem;

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { app } = await createHostedApp({ name: trimmedName, slug: effectiveSlug });
      toasts.push({
        kind: "ok",
        title: `${app.name} was created.`,
        body: "Publish a version to make its address answer.",
      });
      router.push(`/apps/${app.id}`);
    } catch (cause) {
      setError(cause);
      setBusy(false);
    }
  };

  return (
    <div className="product-page mx-auto h-full w-full max-w-[760px] overflow-y-auto">
      <PageHeading
        title="New app"
        description="One published frontend, with its own address and its own invited audience."
      />

      <Card>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!createReason && !busy) void create();
          }}
        >
          <Field
            label="Name"
            help="What the people you invite will see. You can change this later."
            required
          >
            <Input
              value={name}
              autoFocus
              autoComplete="off"
              placeholder="Equipment requests"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field
            label="URL name"
            help={SLUG_RULE}
            error={effectiveSlug && problem ? problem : undefined}
            required
          >
            <Input
              mono
              value={effectiveSlug}
              autoComplete="off"
              placeholder="equipment-requests"
              onChange={(event) => {
                setSlugEdited(true);
                setSlug(event.target.value.trim().toLowerCase());
              }}
            />
          </Field>

          <div className="rounded-card border border-line bg-bg1 px-4 py-3">
            <p className="text-[12px] tracking-[0.02em] text-ink-mute uppercase">Its address</p>
            {domain ? (
              <p className="mt-1 font-mono text-[13px] break-all text-ink">
                {scheme}://{effectiveSlug || "your-app"}.{domain}/
              </p>
            ) : (
              <p className="mt-1 text-[12.5px] text-ink-mute">
                This install has not published an app yet, so this screen cannot show the domain
                they sit under. The full address appears on the app&apos;s own page once it exists.
              </p>
            )}
            <p className="mt-1.5 max-w-[70ch] text-[12.5px] text-ink-mute">
              Only people you invite can open it. Nothing answers on this address until you publish a
              version.
            </p>
          </div>

          {builderBlocked && (
            <Callout tone="warn" title="You can create it, but not publish to it yet">
              <p>
                None of the build runners this install knows about can run right now, so publishing
                to this app would be refused until one of them can.
              </p>
              <ul className="mt-1.5 space-y-1 text-ink-mute">
                {builders.map((builder) => (
                  <li key={builder.id}>
                    {builder.label}: {builder.availability.reason ?? "unavailable."}
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          {error ? <ErrorNote error={error} /> : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={Boolean(createReason)}
              disabledReason={createReason}
            >
              Create app
            </Button>
            <Link
              href="/apps"
              className="inline-flex h-9 items-center rounded-ctl px-3 text-[13px] text-ink-mute transition-colors hover:bg-bg2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
            >
              Cancel
            </Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
