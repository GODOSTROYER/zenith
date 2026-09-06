import type { Deployment, NavigatorRun, NavigatorStep, NavigatorVerification } from "@/lib/domain/types";

/** Presentation only: stored action and audit text remains available verbatim. */
function RecordedReceipt({ original, clarification }: { original: string; clarification?: string }) {
  if (!clarification) return <p>{original}</p>;
  return <div className="space-y-2">
    <p>{clarification}</p>
    <details className="text-[12px] text-ink-mute">
      <summary className="cursor-pointer">Original recorded receipt · includes simulated results</summary>
      <p className="mt-2 break-words border-l border-line pl-3">{original}</p>
    </details>
  </div>;
}

export function StepReceipt({ step, verification, deployment }: {
  step: NavigatorStep;
  verification?: NavigatorVerification;
  deployment?: Deployment;
}) {
  if (!step.resultSummary) return null;
  const sandbox = step.actionId === "deploy.apply" && step.status === "done" && Boolean(step.deploymentId) &&
    verification?.simulated === true && verification.checks?.some(check =>
      check.deploymentId === step.deploymentId && check.provider === "sandbox");
  const simulatedOutputs = step.actionId === "deploy.apply" && step.status === "done" &&
    deployment && deployment.id === step.deploymentId && deployment.outputs.some(output => output.simulated === true);
  const clarification = sandbox
    ? "Sandbox deployment completed. Its outputs are simulated; no live endpoint was verified."
    : simulatedOutputs
      ? "Deployment completed with simulated outputs. Inspect Deploys for each output’s status; a simulated output does not establish a live endpoint."
      : undefined;
  return <RecordedReceipt original={step.resultSummary} clarification={clarification} />;
}

export function RunReceipt({ run, deployments = [] }: { run: NavigatorRun; deployments?: Deployment[] }) {
  if (!run.summary) return null;
  const simulated = run.verification?.simulated === true || run.steps.some(step =>
    step.actionId === "deploy.apply" && step.status === "done" && step.deploymentId &&
    deployments.find(deployment => deployment.id === step.deploymentId)?.outputs.some(output => output.simulated === true));
  return <RecordedReceipt original={run.summary} clarification={simulated
    ? "This run includes simulated deployment results. Inspect each step for its recorded outcome. Live provider state has not been verified for the whole run."
    : undefined} />;
}
