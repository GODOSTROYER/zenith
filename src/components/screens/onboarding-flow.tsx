"use client";
/**
 * Onboarding — three decisions, in order, with nothing hidden.
 *
 * This file is the orchestrator only: which step is showing, what each step
 * handed the next, and where a finished flow goes. The steps themselves live
 * in ./onboarding/step-*.tsx and know nothing about each other.
 *
 * Nothing is created until the last step's button: abandoning the flow leaves
 * no phantom project, no phantom environment and no phantom cloud connection.
 * The workspace is the exception and it says so — it is the account, not a
 * resource. The connection has to exist before the first environment can point
 * at it, so the last step creates the two together, in that order.
 */
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { useJson } from "@/lib/client/api";
import { Button, Callout, ThemeToggle } from "@/components/ui";
import { ErrorNote, useSafeToasts } from "./shared";
import { Rail } from "./onboarding/rail";
import { StepProvider } from "./onboarding/step-provider";
import { StepSystem } from "./onboarding/step-system";
import { StepWorkspace } from "./onboarding/step-workspace";
import {
  STEPS,
  type BlueprintCard,
  type Bootstrap,
  type ProviderChoice,
} from "./onboarding/types";

/** Re-exported: `app/onboarding/page.tsx` builds the catalog on the server. */
export type { BlueprintCard };

export interface OnboardingFlowProps {
  blueprints: BlueprintCard[];
  sampleCompose: string;
}

export function OnboardingFlow({ blueprints, sampleCompose }: OnboardingFlowProps) {
  const router = useRouter();
  const params = useSearchParams();
  const toasts = useSafeToasts();
  const boot = useJson<Bootstrap>("/api/bootstrap");
  const hasWorkspace = !!boot.data?.workspace;
  // 404 is the ordinary first-run answer ("no workspace yet"), which step 1
  // exists to fix. Anything else is a real failure and must not be papered
  // over with a step the user cannot complete.
  const bootFailed = boot.error && boot.error.status !== 404;

  const [step, setStep] = useState(1);
  const [settled, setSettled] = useState(false);
  const [redirect, setRedirect] = useState<string>();
  /** what step 2 settled on; step 3 connects it and builds the environment */
  const [choice, setChoice] = useState<ProviderChoice>();

  // `?step=` is honoured when it is reachable. A workspace that already exists
  // means step 1 is behind us, so the default without a parameter is step 3
  // (the overview's "New project" card). A step that is not reachable yet is
  // never silently swapped for another — the redirect says so.
  useEffect(() => {
    if (settled || boot.loading) return;
    setSettled(true);
    const raw = params.get("step");
    const wanted = Number(raw);
    const asked = raw !== null && Number.isInteger(wanted) && wanted >= 1 && wanted <= 3;

    if (!hasWorkspace) {
      setStep(1);
      if (asked && wanted > 1)
        setRedirect(
          `You asked for step ${wanted}, but this workspace does not exist yet. Starting at step 1 — the rest needs a workspace to hang off.`
        );
      else if (raw !== null && !asked)
        setRedirect(`There is no step "${raw}". Starting at step 1.`);
      return;
    }

    if (asked) {
      setStep(wanted);
      return;
    }
    setStep(3);
    if (raw !== null) setRedirect(`There is no step "${raw}". Showing the system picker.`);
  }, [settled, boot.loading, hasWorkspace, params]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1160px] gap-14 px-8 py-12 lg:px-12">
      <Rail step={step} onGo={(n) => (n < step || (n === 2 && hasWorkspace)) && setStep(n)} />

      <main className="min-w-0 flex-1 pb-16">
        <div className="mb-10 flex items-start justify-between gap-6">
          <div>
            <p className="text-[12px] tracking-[0.08em] text-signal uppercase">Orrery</p>
            <h1 className="mt-2 text-[40px] leading-[1.1] font-medium tracking-[-0.02em] text-ink">
              {STEPS[step - 1].title}
            </h1>
            {/* The rail is the progress indicator from md up; below it, this is. */}
            <p className="mt-2 text-[12.5px] text-ink-faint md:hidden">
              Step {step} of {STEPS.length} · {STEPS[step - 1].hint} · nothing is created until
              step {STEPS.length}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {hasWorkspace && (
              <Button variant="quiet" size="sm" onClick={() => router.push("/overview")}>
                Leave setup
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>

        {redirect && (
          // Arrives on navigation, after the page has been read: announced.
          <Callout tone="info" live="status" className="mb-6">
            {redirect}
          </Callout>
        )}

        {bootFailed ? (
          <div className="max-w-[620px] space-y-4">
            <ErrorNote error={boot.error} />
            <p className="text-[13px] text-ink-mute">
              Onboarding reads your workspace, connections and providers from{" "}
              <span className="font-mono text-[12.5px] text-ink">/api/bootstrap</span> before it
              can show you a step it can actually finish.
            </p>
            <Button onClick={boot.refresh} icon={<ArrowRight className="h-3.5 w-3.5" />}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            {step === 1 && (
              <StepWorkspace
                existing={boot.data?.workspace}
                loading={boot.loading}
                onDone={() => {
                  boot.refresh();
                  setStep(2);
                }}
              />
            )}

            {step === 2 && (
              <StepProvider
                providers={boot.data?.providers ?? []}
                connections={boot.data?.connections ?? []}
                loading={boot.loading}
                onBack={() => setStep(1)}
                onNext={(next) => {
                  setChoice(next);
                  setStep(3);
                }}
              />
            )}

            {step === 3 && (
              <StepSystem
                blueprints={blueprints}
                sampleCompose={sampleCompose}
                choice={choice}
                onBack={() => setStep(2)}
                onCreated={(slug, message) => {
                  toasts.push({ kind: "ok", title: message });
                  router.push(`/p/${slug}`);
                }}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
