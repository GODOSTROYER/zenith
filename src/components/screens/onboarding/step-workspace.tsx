"use client";
/** Step 1 — the workspace. The one thing onboarding creates before the last step. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { api, ApiError } from "@/lib/client/api";
import type { Workspace } from "@/lib/domain/types";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorNote } from "../shared";

export interface StepWorkspaceProps {
  existing: Workspace | undefined;
  loading: boolean;
  onDone: () => void;
}

export function StepWorkspace({ existing, loading, onDone }: StepWorkspaceProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [conflict, setConflict] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    setConflict(null);
    try {
      await api<{ workspace: Workspace }>("/api/workspace", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(e.message);
      else setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Skeleton height={180} />;

  if (existing)
    return (
      <div className="max-w-[620px] space-y-6 animate-enter">
        <p className="text-[16px] leading-relaxed text-ink-mute">
          You already have a workspace: <span className="text-ink">{existing.name}</span>. Orrery
          runs one workspace locally, so this step is done.
        </p>
        <div className="flex gap-2">
          <Button onClick={onDone} icon={<ArrowRight className="h-3.5 w-3.5" />}>
            Continue
          </Button>
          <Button variant="quiet" onClick={() => router.push("/overview")}>
            Go to overview
          </Button>
        </div>
      </div>
    );

  return (
    <div className="max-w-[620px] space-y-7 animate-enter">
      <p className="text-[16px] leading-relaxed text-ink-mute">
        A workspace holds your projects, cloud connections and audit history. One is enough —
        you can rename it later.
      </p>

      <Field
        label="Workspace name"
        help="Usually your company or team. It shows up in the top bar and in every audit entry."
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && submit()}
          placeholder="Kepler Labs"
          maxLength={60}
          autoFocus
        />
      </Field>

      {conflict && (
        <Callout tone="info">
          <p className="text-ink">{conflict}</p>
          <p className="mt-1 text-ink-mute">
            Local Orrery runs a single workspace. Use the one you have, or reset with{" "}
            <span className="font-mono">npm run seed</span>.
          </p>
          <Link href="/overview" className="mt-2 inline-block text-signal hover:underline">
            Open the workspace →
          </Link>
        </Callout>
      )}
      {error ? <ErrorNote error={error} /> : null}

      <Button
        busy={busy}
        disabled={!name.trim()}
        disabledReason="Give the workspace a name first."
        onClick={submit}
        icon={<ArrowRight className="h-3.5 w-3.5" />}
      >
        Create workspace
      </Button>
    </div>
  );
}
