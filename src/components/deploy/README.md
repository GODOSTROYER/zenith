# components/deploy — deploying, and what it produced

`deploy-dock.tsx` is the bar on the map; `changes-review.tsx` is what is about
to be applied; `live-progress.tsx` streams a running deployment;
`success-panel.tsx` is the one celebration Zenith gets. `output-link.ts` and
`caller-role.ts` are the pure/hook helpers behind them, both tested.

Everything a deployment produces is labelled honestly: a sandbox address says
simulated, a cost says estimate. Screens under `src/app/**` may import from
here; nothing here imports a screen.

Change review loads the selected environment's actual deployed revision for
the shared spatial rehearsal. A first deployment has no current manifest;
failed revision reads remain explicit and never become an empty comparison.
Deployment step selection uses the shared read-only ConnectedDetail surface.
The existing approval → execution handoff retains revision, resource, environment
and cost context. Stream log bursts are batched without discarding history;
Download all exports the full received log. `deployment-state.ts` prevents stale
stream patches from rewinding authoritative completed records or later phases.
