# components/platform — the control plane, as screens can show it

Presentational views of the platform control plane: operations and their
timeline, approvals, OpenTofu plans, policy decisions, desired/observed/runtime
resource state, drift, incident investigations, cost and placement estimates,
the autonomy level, and connecting an AWS account. Nothing here fetches: data
and callbacks come in as props, and every surface has a loading, an empty and
an error state (`async-gate.tsx`).

| Component | File | Data contract (types only) |
| --- | --- | --- |
| `OperationStatusBadge`, `OperationTimeline` | `operation-status.tsx`, `operation-timeline.tsx` | `OperationStatus`, `PlatformEvent` |
| `ApprovalCard` (+ `approvalEligibility`) | `approval-card.tsx`, `approval-eligibility.ts` | `OperationRecord`, `ApprovalRecord`, `PolicyDecisionRecord`, `PlanView` |
| `PlanChangesTable` | `plan-changes-table.tsx` | `PlanView` (`src/lib/tofu/plan.ts`) |
| `PolicyDecisionPanel` | `policy-decision-panel.tsx` | `PolicyDecisionRecord` |
| `ResourceStateTable`, `ResourceStateDetail` | `resource-state-*.tsx` | `ResourceNode`, `Observation`, `RuntimeState`, `DriftReport` |
| `DriftList` | `drift-list.tsx` | `DriftReport` |
| `InvestigationView` | `investigation-view.tsx` | `Investigation` |
| `CostEstimateCard`, `PlacementComparison` | `cost-estimate-card.tsx`, `placement-comparison.tsx` | `CostEstimate`, `PlacementResult` |
| `AutonomyControl` | `autonomy-control.tsx` | `AutonomyLevel` |
| `AwsConnectionSetup` | `aws-connection-setup.tsx` | `AwsConnectionConfig` |

Rules that hold for every file in this folder:

- **Client-safe.** Contracts are `import type` only. No `node:` API, no
  control-plane digest, resources barrel, tofu runner, policy engine or
  placement price book. Helpers the components need live here (`text.ts`).
- **Honest.** An attribute nobody read is "Not observed (reason)", never blank
  and never "matches". Estimates are labelled estimates, weak price evidence is
  flagged per line, simulated data says "simulated", sensitive plan values show
  only "(sensitive)", and "(known after apply)" is kept as written.
- **No dead controls.** A disabled button states why, in visible text linked with
  `aria-describedby`. A button that needs a host callback is not drawn when the
  host did not supply one.
- **No raw codes without a sentence.** Enum values and machine codes get a label
  (`labels.ts`); the code itself appears only in a disclosure or tooltip.
- **Kit only.** Primitives, tokens and type scale come from `components/ui`;
  no colours are hardcoded.
- **Untrusted text is data.** Strings that originate in manifests, cloud
  responses or tool output are rendered as text, never as markup or instructions.

Pure logic sits beside the component in a plain `.ts` (`approval-eligibility.ts`,
`event-sentences.ts`, `resource-state-model.ts`, `plan-values.ts`,
`policy-language.ts`, `investigation-model.ts`, `price-evidence.ts`,
`aws-connection-validation.ts`) and is unit-tested in `tests/screens/platform/`.
