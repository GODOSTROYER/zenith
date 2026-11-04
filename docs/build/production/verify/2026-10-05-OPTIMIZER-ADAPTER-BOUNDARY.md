# Optimizer adapter and reconciliation boundary correction

The placement purity check failed because the scheduled optimizer pass, an application adapter with injected storage, broker and clock ports, lived beside the pure placement calculations. Its complete source moves unchanged to `src/lib/platform/optimizer-pass.ts`; the production platform and workflow imports follow it. The pass still proposes through the broker under the existing environment guard and never approves or starts execution.

Reconciliation imports the exact ownership drift module and supplies its existing injected `startedAt` clock to classification. The boundary test admits that exact module and the adapter's pure stability/digest modules, while explicitly refusing adjacent ownership/incident modules, product storage and filesystem imports. Existing I/O, environment, cycle and route checks remain intact.

All checks are unrun by the author. Root verification must run the placement purity, optimizer, reconciliation boundary/core, platform and workflow tests. This source correction supplies no native execution evidence.

Integration follow-up: the separately owned optimizer fixture packet retains its old import. After that packet is frozen, change only its `tests/placement/optimizer-pass.test.ts` import to `@/lib/platform/optimizer-pass`; preserve its independently reviewed fixture changes. No other path is part of this packet.
