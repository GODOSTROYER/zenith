# Workflow start recovery safeguards

Source: `7d75b21d884da6f3beae2889740b0a52d9118eee`.
Integration: `dde129854ced283434cb9cfecd930d11714d1b88`.
Author and committer: Saivedant Hava <saivedant169@gmail.com>, on his Mac.

A lost workflow start response previously allowed the product projection to
claim failure, finish steps and release its active writer while the worker
could still be running. Startup now preserves nonterminal progress and the
writer, records explicit inspection guidance, and refuses another start for an
uncertain operation. A failed initial authority read or failed ledger settlement
cannot establish that no workflow exists. Proven input rejection before dispatch
can still settle as a failure.

The trusted recorded plan round controls concrete browser review even when the
caller lost the start acknowledgement. It does not mint another approval or
start a second workflow. Late authoritative success takes precedence and clears
the uncertainty notice. The UI shows last reported steps without pretending
that an unconfirmed workflow is still progressing.

Root verification before integration:

- 105 focused tests passed, zero failures or skips. Includes an actual isolated
  Temporal accepted start, lost response, late completion and duplicate refusal,
  plus real network OpenTofu. No provider write is implied.
- Full typecheck and affected lint passed. Go format/vet/test passed: 226
  top-level cases and 539 subtests, zero failures; three Linux-only cases skipped
  on this Mac. This focused Go run did not use the race detector.
- Fresh canonical platform PostgreSQL: 1,327 passed, zero failures or skips,
  all 39 required groups and separate strict observed schema 2 revalidation.
  The dedicated database container was deleted with ownership and absence proof.
- Fresh local kind provider: 6 passed, zero failed or skipped. Release: one
  passed, zero failed or skipped. The pinned release image was loaded into the
  disposable cluster; cluster, owned containers and private kubeconfig removed.
- Independent source review challenged authority-read outages, plan-round
  handling and misleading UI progress before the candidate was frozen.

Actual local PostgreSQL provenance remains `2c9d6fa` plus the tested source
diff; the artifact is `evidence/engine-acceptance/platform-postgres-start-uncertainty.json`.
Kind proof is `evidence/local-kind/start-uncertainty.json`. That exact source
was committed unchanged. Platform PostgreSQL compatibility does not prove
production product-store projection persistence; kind does not prove managed
CNI isolation or live-cloud behavior.

This bounded correction leaves durable intent/outbox, cross-store crash recovery,
recovery epochs, operator resolution and newly authorized continuation open.
Neither an uncertain provider write nor an unavailable authority is retried
blindly. The green CI reference `2c9d6fa` predates this integration; a complete
new pushed run remains required for the integrated commit.
