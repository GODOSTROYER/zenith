"use client";
/** The "Publish a route" panel — a hostname pointed at a service. */
import { useState } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useProjectData } from "@/components/shell/project-context";
import { PlanFirst } from "./plan-first";

export interface AddRouteFormProps {
  onCreated: (nodeId: string) => void;
}

export function AddRouteForm({ onCreated }: AddRouteFormProps) {
  const { project } = useProjectData();
  const [host, setHost] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [tls, setTls] = useState(true);

  const servable = project.workingManifest.services.filter(
    (s) => s.kind === "web" || s.kind === "static"
  );

  const input: Record<string, unknown> = { tls };
  if (host.trim()) input.host = host.trim();
  if (serviceId) input.serviceId = serviceId;

  return (
    <div className="space-y-4">
      <Field
        label="Hostname"
        help={
          host.trim()
            ? "Your own hostname: point a CNAME at the environment before deploying."
            : "Leave blank for an Zenith.ai-managed hostname with DNS and TLS handled for you."
        }
      >
        <Input
          value={host}
          mono
          autoFocus
          placeholder={`app.${project.slug}.orrery.app`}
          onChange={(e) => setHost(e.target.value)}
        />
      </Field>
      <Field
        label="Serves"
        help={
          servable.length === 0
            ? "Add a web or static service first — only those can answer HTTP."
            : "Public traffic on this hostname reaches the service you pick."
        }
      >
        <Select
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
          options={[
            { value: "", label: "Nothing yet (the route will 404)" },
            ...servable.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
      </Field>
      <div className="flex items-center justify-between gap-3 rounded-ctl border border-line px-3 py-2">
        <span className="text-[13px] text-ink">TLS</span>
        <Switch checked={tls} onChange={setTls} label="Serve over HTTPS" />
      </div>
      <PlanFirst
        actionId="system.addRoute"
        input={input}
        label="Publish route"
        onDone={(r) => {
          const id = (r.data as { routeId?: string } | undefined)?.routeId;
          if (id) onCreated(id);
        }}
      />
    </div>
  );
}
