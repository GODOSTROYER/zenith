# components/deploy — deploying, and what it produced

`deploy-dock.tsx` is the bar on the map; `changes-review.tsx` is what is about
to be applied; `live-progress.tsx` streams a running deployment;
`success-panel.tsx` is the one celebration Orrery gets. `output-link.ts` and
`caller-role.ts` are the pure/hook helpers behind them, both tested.

Everything a deployment produces is labelled honestly: a sandbox address says
simulated, a cost says estimate. Screens under `src/app/**` may import from
here; nothing here imports a screen.
