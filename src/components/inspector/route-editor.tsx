"use client";
/** One published route: where it answers, TLS, path prefix, connections. */
import { useState } from "react";
import { CopyButton, Field, Input, Switch, Tabs } from "@/components/ui";
import { SectionTitle } from "@/components/screens/shared";
import { useProjectData } from "@/components/shell/project-context";
import { PlanFirst } from "./plan-first";
import { BindingList } from "./binding-list";
import { Facts, StaleNotice, useUpstreamGuard } from "./editor-parts";
import type { Route } from "@/lib/domain/types";

/**
 * The address this route actually answers on, taken from the last deployment's
 * outputs rather than reassembled from the manifest — the manifest says what
 * was asked for, the outputs say what exists.
 */
function liveUrl(outputs: { kind: string; value: string; targetId?: string }[], route: Route) {
  const byTarget = outputs.find((o) => o.kind === "url" && o.targetId === route.id);
  if (byTarget) return byTarget.value;
  return outputs.find((o) => o.kind === "url" && o.value.includes(route.host))?.value;
}

export interface RouteEditorProps {
  route: Route;
  onOpenBinding?: (bindingId: string) => void;
}

export function RouteEditor({ route, onOpenBinding }: RouteEditorProps) {
  const { project, deployments, selectedEnv, selectedEnvId } = useProjectData();
  const [tab, setTab] = useState("config");
  const [tls, setTls] = useState(route.tls);
  const [pathPrefix, setPathPrefix] = useState(route.pathPrefix);

  const latest = deployments.find((d) => d.environmentId === selectedEnvId);
  const url = latest ? liveUrl(latest.outputs, route) : undefined;
  const envName = selectedEnv?.name ?? "this environment";

  const input: Record<string, unknown> = { routeId: route.id };
  if (tls !== route.tls) input.tls = tls;
  if (pathPrefix !== route.pathPrefix) input.pathPrefix = pathPrefix.trim();
  const dirty = Object.keys(input).length > 1;
  const guard = useUpstreamGuard(route, dirty, () => {
    setTls(route.tls);
    setPathPrefix(route.pathPrefix);
  });

  return (
    <div className="space-y-4">
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "config", label: "Details" },
          {
            value: "bindings",
            label: "Connections",
            badge:
              project.workingManifest.bindings.filter((b) => b.from === route.id).length ||
              undefined,
          },
          { value: "danger", label: "Danger" },
        ]}
      />

      {tab === "config" && (
        <div className="space-y-4">
          {guard.stale && (
            <StaleNotice name={route.host} onReload={guard.reload} onKeepMine={guard.keepMine} />
          )}
          <Facts
            rows={[
              ["Host", <span key="h" className="font-mono">{route.host}</span>],
              ["DNS", route.managedDns ? "Orrery-managed hostname" : "your own hostname (CNAME)"],
            ]}
          />

          <div className="space-y-1.5 rounded-card border border-line bg-bg1 p-3">
            <SectionTitle>Live in {envName}</SectionTitle>
            {url ? (
              <div className="flex items-center gap-2">
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-signal hover:underline"
                >
                  {url}
                </a>
                <CopyButton value={url} what="the live address" />
              </div>
            ) : (
              <p className="text-[12.5px] text-ink-mute">
                {selectedEnv?.deployedRevisionId
                  ? `The last deployment to ${envName} published no address for ${route.host}. It answers once a deploy that includes this route succeeds.`
                  : `${envName} has never been deployed, so ${route.host} does not resolve yet.`}
              </p>
            )}
          </div>

          <p className="text-[12.5px] text-ink-mute">
            A hostname is an identity, not a setting — to change it, publish a new route and remove
            this one, so the old address keeps working until you say otherwise.
          </p>

          <div className="flex items-center justify-between gap-3 rounded-ctl border border-line px-3 py-2">
            <div className="min-w-0">
              <span className="text-[13px] text-ink">TLS</span>
              <p className="text-[12px] text-ink-mute">
                {tls
                  ? route.managedDns
                    ? "Certificate issued and renewed by Orrery."
                    : "Certificate issues once the hostname resolves to this environment."
                  : "Traffic travels as plaintext — anything on the path can read it."}
              </p>
            </div>
            <Switch checked={tls} onChange={setTls} label="Serve over HTTPS" />
          </div>

          <Field
            label="Path prefix"
            help="Which requests on this hostname reach this route. Leading slash added if you leave it off."
          >
            <Input value={pathPrefix} mono onChange={(e) => setPathPrefix(e.target.value)} />
          </Field>

          <PlanFirst
            actionId="system.updateRoute"
            input={input}
            label="Apply change"
            disabled={!dirty || guard.stale}
            disabledReason={
              guard.stale
                ? `${route.host} changed underneath this form. Load the new values, or keep yours, before applying.`
                : "Change TLS or the path prefix first — there is nothing to apply yet."
            }
            onCancel={
              dirty
                ? () => {
                    setTls(route.tls);
                    setPathPrefix(route.pathPrefix);
                  }
                : undefined
            }
          />
        </div>
      )}

      {tab === "bindings" && <BindingList nodeId={route.id} onOpen={onOpenBinding} />}

      {tab === "danger" && (
        <div className="space-y-3">
          <p className="text-[13px] text-ink-mute">
            {route.host} stops resolving once this is deployed. Anything pointing at it breaks.
          </p>
          <PlanFirst
            actionId="system.removeRoute"
            input={{ routeId: route.id }}
            label={`Unpublish ${route.host}`}
            variant="danger"
          />
        </div>
      )}
    </div>
  );
}
