"use client";
/**
 * Env & secrets for one service.
 *
 * What the server's secret store holds, as metadata. `GET /api/secrets` never
 * returns a value and there is no route that does, so this is everything the
 * browser can know: which references have something behind them, which version
 * it is on, and when it last changed. The shape and the fetch live in
 * `lib/client/secrets`, shared with Settings → Secrets.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TimeAgo } from "@/components/ui/time-ago";
import { SectionTitle } from "@/components/screens/shared";
import { useSecrets, type SecretRow, type SecretsView } from "@/lib/client/secrets";
import { PlanFirst } from "./plan-first";
import type { Service } from "@/lib/domain/types";

/** Where a variable's value actually is, in the words the panel uses. */
function secretHome(store: SecretsView | undefined, ref: string): SecretRow | undefined {
  return store?.secrets.find((s) => s.ref === ref);
}

/**
 * The store is off. Say it once, plainly, with the variable to set — not as an
 * error (nothing is broken) and not as a shrug (the Value field really is
 * unavailable until someone does this).
 */
function StoreOffNotice({ store }: { store: SecretsView }) {
  return (
    <Callout tone="warn" compact>
      <p>
        {store.reason} {store.fix} Until then Zenith can record a{" "}
        <em className="not-italic text-ink-mute">reference</em> to a value you keep elsewhere, and
        your provider resolves it at deploy time.
      </p>
    </Callout>
  );
}

/**
 * One variable, editable where it is listed. `system.setEnvVar` overwrites a
 * key that already exists, so editing is the same action as adding — there was
 * never a reason to make people remove and retype a value to change it.
 *
 * A secret row is a different thing: the value is not here to edit, so the row
 * shows what the store knows about it instead — version, when, by whom — and
 * offers the two operations that make sense on a value you cannot see.
 */
function EnvRow({
  serviceId,
  entry,
  store,
  onStoreChange,
}: {
  serviceId: string;
  entry: Service["env"][number];
  store: SecretsView | undefined;
  onStoreChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [value, setValue] = useState(entry.value ?? "");
  const [nextSecret, setNextSecret] = useState("");

  const ref = entry.secretRef;
  const changed = value !== (entry.value ?? "");
  const held = ref ? secretHome(store, ref) : undefined;
  const ours = Boolean(ref?.startsWith("vault:"));

  return (
    <li className="group space-y-1.5 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[12px] text-ink">{entry.key}</span>
        {editing ? (
          <Input
            value={value}
            mono
            autoFocus
            aria-label={`Value of ${entry.key}`}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-ink-mute">
            {ref ? (
              <span title={`Stored under ${ref}. The value is never sent to the browser.`}>
                •••••••• <span className="text-ink-faint">secret</span>
              </span>
            ) : (
              entry.value
            )}
          </span>
        )}
      </div>

      {/* Where this secret's value lives, and whether it is actually there. */}
      {ref && !editing && (
        <p className="font-mono text-[11.5px] text-ink-faint">
          {ref}
          {held ? (
            <>
              {" · "}v{held.version}
              {" · "}
              <TimeAgo iso={held.updatedAt} prefix="updated" className="font-mono" />
              {" by "}
              {held.updatedBy}
            </>
          ) : !ours ? (
            <span className="text-ink-mute"> · your secret manager resolves this, not Zenith</span>
          ) : store && !store.configured ? (
            <span className="text-warn"> · the secret store is off on this server</span>
          ) : store ? (
            <span className="text-warn"> · no value stored — set one before deploying</span>
          ) : null}
        </p>
      )}

      {/* Quiet, never invisible — an opacity-0 control does not
          exist on a touch screen or to anyone scanning the list. */}
      <div className="flex flex-wrap items-center gap-2 opacity-60 transition-opacity duration-[120ms] group-hover:opacity-100 focus-within:opacity-100">
        {ref ? (
          <>
            {rotating ? (
              <div className="w-full space-y-2">
                <Field
                  label={`New value for ${entry.key}`}
                  help={
                    ours
                      ? "Stored encrypted on this Zenith server under the same reference, as the next version. Running services keep the old value until you redeploy."
                      : `${ref} is not Zenith's to write. Rotate it in your own secret manager, then redeploy.`
                  }
                >
                  <Input
                    type="password"
                    value={nextSecret}
                    mono
                    autoFocus
                    autoComplete="off"
                    placeholder="sk_live_…"
                    onChange={(e) => setNextSecret(e.target.value)}
                  />
                </Field>
                <PlanFirst
                  actionId="system.rotateSecret"
                  input={{ serviceId, key: entry.key, secretValue: nextSecret }}
                  label="Rotate"
                  variant="quiet"
                  disabled={!nextSecret}
                  disabledReason="Type the new value first — rotating to nothing is not a rotation."
                  onDone={() => {
                    setNextSecret("");
                    setRotating(false);
                    onStoreChange();
                  }}
                  onCancel={() => {
                    setNextSecret("");
                    setRotating(false);
                  }}
                />
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={!ours || (store && !store.configured)}
                disabledReason={
                  !ours
                    ? `${ref} lives in your own secret manager. Rotate it there, then redeploy so services pick it up.`
                    : store?.reason && store?.fix
                      ? `${store.reason} ${store.fix}`
                      : undefined
                }
                onClick={() => setRotating(true)}
              >
                Rotate
              </Button>
            )}
            <PlanFirst
              actionId="system.removeSecret"
              input={{ serviceId, key: entry.key }}
              label="Remove"
              variant="ghost"
              onDone={onStoreChange}
            />
          </>
        ) : (
          <>
            {editing ? (
              <PlanFirst
                actionId="system.setEnvVar"
                input={{ serviceId, key: entry.key, value }}
                label="Save value"
                variant="quiet"
                disabled={!changed}
                disabledReason="The value is unchanged — there is nothing to apply."
                onDone={() => setEditing(false)}
                onCancel={() => {
                  setValue(entry.value ?? "");
                  setEditing(false);
                }}
              />
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <PlanFirst
              actionId="system.setEnvVar"
              input={{ serviceId, key: entry.key, value: null }}
              label="Remove"
              variant="ghost"
            />
          </>
        )}
      </div>
    </li>
  );
}

export interface EnvPanelProps {
  service: Service;
}

export function EnvPanel({ service }: EnvPanelProps) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const { store, refresh } = useSecrets();

  // Until the fetch lands, neither state is known — so the form does not claim
  // one. `off` is only true once the server has actually said so.
  const off = store !== undefined && !store.configured;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <SectionTitle>Set on {service.name}</SectionTitle>
        {service.env.length === 0 ? (
          <p className="text-[13px] text-ink-mute">
            No variables of its own yet. Anything this service is connected to already injects its
            own configuration — see the Connections tab.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-card border border-line">
            {service.env.map((e) => (
              <EnvRow
                key={e.key}
                serviceId={service.id}
                entry={e}
                store={store}
                onStoreChange={refresh}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3 border-t border-line pt-4">
        <SectionTitle>Add a variable</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Key">
            <Input value={key} mono onChange={(e) => setKey(e.target.value)} placeholder="LOG_LEVEL" />
          </Field>
          <Field label="Value">
            <Input value={value} mono onChange={(e) => setValue(e.target.value)} placeholder="info" />
          </Field>
        </div>
        <PlanFirst
          actionId="system.setEnvVar"
          input={{ serviceId: service.id, key: key.trim(), value }}
          label="Add variable"
          disabled={!key.trim()}
          disabledReason="Give the variable a name first."
          onDone={() => {
            setKey("");
            setValue("");
          }}
        />
      </div>

      <div className="space-y-3 border-t border-line pt-4">
        <SectionTitle>Add a secret</SectionTitle>
        <p className="text-[12.5px] text-ink-mute">
          The manifest records only the reference <code className="font-mono">vault:KEY</code> — the
          value never lands in the diff, a revision, the audit log or an export bundle.
        </p>
        {off && store && <StoreOffNotice store={store} />}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Key">
            <Input
              value={secretKey}
              mono
              onChange={(e) => setSecretKey(e.target.value)}
              placeholder="STRIPE_API_KEY"
            />
          </Field>
          <Field
            label="Value"
            help={
              off
                ? "Unavailable: this server has no secret store, so a value typed here could only be discarded. Set ZENITH_SECRET_KEY (above) to turn it on."
                : "Stored encrypted on this Zenith server; the manifest keeps only the reference."
            }
          >
            <Input
              type="password"
              value={secretValue}
              mono
              autoComplete="off"
              disabled={off}
              onChange={(e) => setSecretValue(e.target.value)}
              placeholder={off ? "unavailable" : "sk_live_…"}
            />
          </Field>
        </div>
        <PlanFirst
          actionId="system.setSecret"
          // An empty string is "no value given" — that is the reference-only
          // path, which stays available whether or not the store is on.
          input={{
            serviceId: service.id,
            key: secretKey.trim(),
            ...(secretValue ? { secretValue } : {}),
          }}
          label={secretValue ? "Store the secret" : "Write the reference"}
          disabled={!secretKey.trim()}
          disabledReason="Give the secret a name first."
          onDone={() => {
            setSecretKey("");
            setSecretValue("");
            refresh();
          }}
        />
      </div>
    </div>
  );
}
