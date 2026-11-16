# Full gate fixture corrections, 2026-10-04

The root full run on `78d084a` failed with 18,231 passed, five failed and 715 skipped. The independent workflow run failed with 1,089 passed, four failed and 56 skipped. Those receipts remain failed. This packet changes two tests and this handoff; it changes no product code, authority guard, exemption, case identity, skip or gate manifest.

The SQL audit's five hits are the native workflow-start repository's fixed `LIVE_AUTHORITY`/`MCP_DEPLOY_AUTHORITY` composition and literal parameter indexes 12/13, with the next binding index adding literal 1. The new recognition checks the exact repository, exact composition, actual interpolation-free local/imported fragment definitions and fixed import. Numeric recognition requires the literal 12/13 declaration and `$${...}` placeholder position. Dynamic fragment/value/index, non-parameter placement and foreign-repository controls refuse this recognition. Existing tenant predicate, worker-only caller and exemption audits are unchanged. This remains a source text audit; native tenancy tests prove behavior separately.

The MCP caller controls read the actual immutable operation input through the supported `McpDeployInput` contract and require its saved deployment's operation, principal and full input association. They assert every scalar payload field, explicit `new` start mode and exact Temporal argument payload. Human-required execution refuses before approval with no claim or start. The real approval is unconsumed after approval and consumed inside the start callback. `preApproved: true` conveys consumption of the initial proposal; it supplies no concrete-plan approval. The existing bridge payload controls and day-two field assertions remain.

Policy and product admission ports in this suite are declared models. The broker/store claim and approval are real test implementations; Temporal transport is intercepted. These controls do not prove real PostgreSQL admission, Temporal execution, default browser/API operation or cloud writes.

The author ran no tests, imports, compiler, lint or services. Independent source review and root execution remain required. Root should run the two affected files with the pinned Node 22 runtime and the existing serial Vitest command, then use the canonical full/workflow gates when composing the candidate.

Outside-owned follow-ups: no production defect was established by these five failures. Native runtime, full gate skips and existing browser/API/cloud authorization remain root-owned acceptance work. The frozen OAuth grant packet and its separately authorized trigger-verifier correction are independent.


Revision 2 corrects only application import ordering. The authentic McpDeployInput schema loads dynamically after tempDataDir, so its db/store dependency cannot pin the ambient data directory before fixture ownership is established. All payload, association, pre-approval refusal and consumed-approval assertions remain byte-exact. SQL audit source is unchanged. Revision 1 remains immutable; no author runtime was executed, and fresh independent source/runtime verification is required.
